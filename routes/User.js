const express = require("express");
const router = express.Router();
const User = require("../models/user");
const { sendOTPEmail, sendResetPasswordEmail, sendWelcomeEmail } = require("../services/email");
const { createTokenForUser } = require("../services/authentication");
const { emailQueue } = require("../services/queue");
const crypto = require("crypto");
const { loginLimiter, otpLimiter, signupLimiter } = require("../middlewares/rateLimiting");
const { validateEmail } = require("../middlewares/validation");

const OTP_EXPIRY_MS = 5 * 60 * 1000;
const RESET_EXPIRY_MS = 30 * 60 * 1000;
const MAX_PASSWORD_LENGTH = 128;

const otpStore = new Map();
const resetTokens = new Map();

const generateSecureOTP = () => crypto.randomInt(100000, 999999).toString();
const generateSecureToken = () => crypto.randomBytes(32).toString("hex");

setInterval(() => {
  const now = Date.now();
  let otpCleaned = 0, tokenCleaned = 0;
  for (const [key, data] of otpStore.entries()) { if (data.expires < now) { otpStore.delete(key); otpCleaned++; } }
  for (const [key, data] of resetTokens.entries()) { if (data.expires < now) { resetTokens.delete(key); tokenCleaned++; } }
  if (otpCleaned > 0 || tokenCleaned > 0) console.log(`Cleanup: Removed ${otpCleaned} expired OTPs, ${tokenCleaned} expired reset tokens`);
}, 5 * 60 * 1000);

router.get("/signin", (req, res) => {
  if (req.user) return res.redirect("/");
  res.render("signin", { error: null });
});

router.post("/signin", loginLimiter, async (req, res) => {
  const { email, password } = req.body;
  try {
    if (!email || !password) return res.status(400).json({ success: false, message: "Email and password are required" });
    if (!validateEmail(email)) return res.status(400).json({ success: false, message: "Invalid email format" });
    if (password.length > MAX_PASSWORD_LENGTH) return res.status(400).json({ success: false, message: "Password too long" });
    const token = await User.matchPassword(email, password);
    res.cookie("token", token, { httpOnly: true, secure: process.env.NODE_ENV === "production", sameSite: "strict", maxAge: 7 * 24 * 60 * 60 * 1000 });
    res.status(200).json({ success: true, message: "Login successful", redirect: "/" });
  } catch (error) {
    console.error("Signin Error:", error.message);
    res.status(401).json({ success: false, message: "Invalid email or password" });
  }
});

router.get("/logout", (req, res) => { res.clearCookie("token", { httpOnly: true, secure: process.env.NODE_ENV === "production", sameSite: "strict" }); res.redirect("/"); });
router.post("/logout", (req, res) => { res.clearCookie("token", { httpOnly: true, secure: process.env.NODE_ENV === "production", sameSite: "strict" }); res.status(200).json({ success: true, message: "Logged out successfully" }); });

router.get("/signup", (req, res) => {
  if (req.user) return res.redirect("/");
  res.render("signup", { error: null });
});

router.post("/send-otp", otpLimiter, async (req, res) => {
  const { email } = req.body;
  if (!email || !validateEmail(email)) return res.status(400).json({ success: false, message: "Valid email is required" });
  const normalizedEmail = email.toLowerCase().trim();
  const existingUser = await User.findOne({ email: normalizedEmail }).lean().select("_id");
  if (existingUser) return res.status(409).json({ success: false, message: "Email already registered. Please login instead." });
  const otp = generateSecureOTP();
  otpStore.set(normalizedEmail, { otp, expires: Date.now() + OTP_EXPIRY_MS, attempts: 0 });
  emailQueue.add(() => sendOTPEmail(normalizedEmail, otp));
  return res.status(202).json({ success: true, message: "OTP is being sent to your email. It expires in 5 minutes." });
});

router.post("/signup", signupLimiter, async (req, res) => {
  const { fullName, email, password, otp } = req.body;
  if (!fullName || !email || !password || !otp) return res.status(400).json({ success: false, message: "All fields are required" });
  const normalizedEmail = email.toLowerCase().trim();
  if (!validateEmail(normalizedEmail)) return res.status(400).json({ success: false, message: "Invalid email format" });
  if (password.length < 6 || password.length > MAX_PASSWORD_LENGTH) return res.status(400).json({ success: false, message: "Password must be 6-128 characters" });
  if (fullName.length > 100) return res.status(400).json({ success: false, message: "Name too long" });
  const stored = otpStore.get(normalizedEmail);
  if (!stored) return res.status(400).json({ success: false, message: "No OTP found. Please request a new one." });
  if (stored.attempts >= 3) { otpStore.delete(normalizedEmail); return res.status(400).json({ success: false, message: "Too many failed attempts. Request a new OTP." }); }
  if (stored.otp !== otp) { stored.attempts++; return res.status(400).json({ success: false, message: "Invalid OTP" }); }
  if (stored.expires < Date.now()) { otpStore.delete(normalizedEmail); return res.status(400).json({ success: false, message: "OTP has expired" }); }
  try {
    const user = await User.create({ fullName: fullName.trim().substring(0, 100), email: normalizedEmail, password });
    otpStore.delete(normalizedEmail);
    const token = createTokenForUser(user);
    res.cookie("token", token, { httpOnly: true, secure: process.env.NODE_ENV === "production", sameSite: "strict", maxAge: 7 * 24 * 60 * 60 * 1000 });
    emailQueue.add(() => sendWelcomeEmail(normalizedEmail, fullName.trim()));
    return res.json({ success: true, message: "Account created successfully!", redirect: "/" });
  } catch (error) {
    if (error.code === 11000 && error.keyPattern?.email) return res.status(409).json({ success: false, message: "Email already registered. Please login instead." });
    console.error("Signup Error:", error);
    return res.status(500).json({ success: false, message: "Signup failed. Please try again." });
  }
});

router.post("/forgot-password", async (req, res) => {
  const { email } = req.body;
  if (!email || !validateEmail(email)) return res.status(400).json({ success: false, message: "Valid email is required" });
  try {
    const normalizedEmail = email.toLowerCase().trim();
    const user = await User.findOne({ email: normalizedEmail }).select("_id");
    if (!user) return res.status(200).json({ success: true, message: "If this email exists, a password reset link has been sent" });
    const resetToken = generateSecureToken();
    resetTokens.set(resetToken, { email: normalizedEmail, expires: Date.now() + RESET_EXPIRY_MS });
    const protocol = req.headers["x-forwarded-proto"] || req.protocol || "https";
    const host = req.headers["x-forwarded-host"] || req.headers.host;
    const resetLink = `${protocol}://${host}/user/reset-password?token=${resetToken}`;
    try { await sendResetPasswordEmail(normalizedEmail, resetLink); } catch (e) {
      console.error("Reset email failed:", e.message);
      return res.status(500).json({ success: false, message: "Email service error" });
    }
    res.json({ success: true, message: "If this email exists, a password reset link has been sent" });
  } catch (error) {
    console.error("Forgot Password Error:", error.message);
    res.status(500).json({ success: false, message: "Failed to send reset link" });
  }
});

router.get("/reset-password", (req, res) => {
  const { token } = req.query;
  if (!token || token.length !== 64 || !/^[a-f0-9]+$/.test(token)) return res.status(400).render("404", { message: "Invalid reset link" });
  const stored = resetTokens.get(token);
  if (!stored) return res.status(400).render("404", { message: "Reset link not found" });
  if (stored.expires < Date.now()) { resetTokens.delete(token); return res.status(400).render("404", { message: "Reset link has expired" }); }
  res.render("reset-password", { token, error: null });
});

router.post("/reset-password", async (req, res) => {
  const { token, newPassword, confirmPassword } = req.body;
  if (!token || !newPassword || !confirmPassword) return res.status(400).json({ success: false, message: "All fields are required" });
  if (newPassword !== confirmPassword) return res.status(400).json({ success: false, message: "Passwords do not match" });
  if (newPassword.length < 6 || newPassword.length > MAX_PASSWORD_LENGTH) return res.status(400).json({ success: false, message: "Password must be 6-128 characters" });
  try {
    const stored = resetTokens.get(token);
    if (!stored) return res.status(400).json({ success: false, message: "Reset link not found" });
    if (stored.expires < Date.now()) { resetTokens.delete(token); return res.status(400).json({ success: false, message: "Reset link has expired" }); }
    const user = await User.findOne({ email: stored.email });
    if (!user) return res.status(404).json({ success: false, message: "User not found" });
    user.password = newPassword;
    await user.save();
    resetTokens.delete(token);
    res.json({ success: true, message: "Password reset successfully", redirect: "/user/signin" });
  } catch (error) {
    console.error("Reset Password Error:", error.message);
    res.status(500).json({ success: false, message: "Failed to reset password" });
  }
});

module.exports = router;
