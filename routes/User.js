const express = require('express');
const router = express.Router();
const User = require('../models/user');
const { sendOTPEmail, sendResetPasswordEmail, sendWelcomeEmail } = require('../services/email');
const { creatTokenForUser } = require('../services/authentication');
const { emailQueue } = require('../services/queue');
const crypto = require('crypto');
const { loginLimiter, otpLimiter, signupLimiter } = require('../middlewares/rateLimiting');
const { validateEmail } = require('../middlewares/validation');

const otpStore = new Map();
const resetTokens = new Map();

// TEST EMAIL
router.post('/test-email', async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ success: false, message: 'Email is required' });
  try {
    await sendOTPEmail(email, '123456');
    return res.json({ success: true, message: `Test email sent to ${email}` });
  } catch (error) {
    console.error("Test email failed:", error);
    return res.status(500).json({ success: false, message: `Email test failed: ${error.message}` });
  }
});

// GET signin page
router.get('/signin', (req, res) => {
  if (req.user) return res.redirect('/');
  res.render('signin', { error: null });
});

// POST signin
router.post('/signin', loginLimiter, async (req, res) => {
  const { email, password } = req.body;
  try {
    if (!email || !password) return res.status(400).json({ success: false, message: "Email and password are required" });
    if (!validateEmail(email)) return res.status(400).json({ success: false, message: "Invalid email format" });

    const token = await User.matchPassword(email, password);
    res.cookie("token", token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "strict",
      maxAge: 7 * 24 * 60 * 60 * 1000
    });
    res.status(200).json({ success: true, message: "Login successful", redirect: "/" });
  } catch (error) {
    console.error("Signin Error:", error.message);
    res.status(401).json({ success: false, message: error.message || "Invalid email or password" });
  }
});

// GET/POST logout
router.get('/logout', (req, res) => { res.clearCookie("token"); res.redirect('/'); });
router.post('/logout', (req, res) => { res.clearCookie("token"); res.status(200).json({ success: true, message: "Logged out successfully" }); });

// GET signup page
router.get('/signup', (req, res) => {
  if (req.user) return res.redirect('/');
  res.render('signup', { error: null });
});

// POST send OTP
router.post('/send-otp', otpLimiter, async (req, res) => {
  const { email } = req.body;
  if (!email || !validateEmail(email)) return res.status(400).json({ success: false, message: 'Valid email is required' });

  const normalizedEmail = email.toLowerCase().trim();
  const existingUser = await User.findOne({ email: normalizedEmail }).lean().select('_id');
  if (existingUser) return res.status(409).json({ success: false, message: "Email already registered. Please login instead." });

  const otp = Math.floor(100000 + Math.random() * 900000).toString();
  otpStore.set(normalizedEmail, { otp, expires: Date.now() + 5 * 60 * 1000 });
  emailQueue.add(() => sendOTPEmail(normalizedEmail, otp));

  return res.status(202).json({ success: true, message: "OTP is being sent to your email. It expires in 5 minutes." });
});

// POST signup
router.post('/signup', signupLimiter, async (req, res) => {
  const { fullName, email, password, otp } = req.body;
  if (!fullName || !email || !password || !otp) return res.status(400).json({ success: false, message: "All fields are required" });

  const normalizedEmail = email.toLowerCase().trim();
  if (!validateEmail(normalizedEmail)) return res.status(400).json({ success: false, message: "Invalid email format" });
  if (password.length < 6) return res.status(400).json({ success: false, message: "Password must be at least 6 characters" });

  const stored = otpStore.get(normalizedEmail);
  if (!stored) return res.status(400).json({ success: false, message: "No OTP found. Please request a new one." });
  if (stored.otp !== otp) return res.status(400).json({ success: false, message: "Invalid OTP" });
  if (stored.expires < Date.now()) { otpStore.delete(normalizedEmail); return res.status(400).json({ success: false, message: "OTP has expired" }); }

  try {
    const user = await User.create({ fullName: fullName.trim(), email: normalizedEmail, password });
    otpStore.delete(normalizedEmail);
    const token = creatTokenForUser(user);

    res.cookie("token", token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "strict",
      maxAge: 7 * 24 * 60 * 60 * 1000
    });
    emailQueue.add(() => sendWelcomeEmail(normalizedEmail, fullName.trim()));
    return res.json({ success: true, message: "Account created successfully!", redirect: "/" });
  } catch (error) {
    if (error.code === 11000 && error.keyPattern?.email) return res.status(409).json({ success: false, message: "Email already registered. Please login instead." });
    console.error("Signup Error:", error);
    return res.status(500).json({ success: false, message: "Signup failed. Please try again." });
  }
});

// POST forgot password
router.post('/forgot-password', async (req, res) => {
  const { email } = req.body;
  if (!email || !validateEmail(email)) return res.status(400).json({ success: false, message: "Valid email is required" });

  try {
    const normalizedEmail = email.toLowerCase().trim();
    const user = await User.findOne({ email: normalizedEmail });
    if (!user) return res.status(200).json({ success: true, message: "If this email exists, a password reset link has been sent" });

    const resetToken = crypto.randomBytes(32).toString('hex');
    resetTokens.set(resetToken, { email: normalizedEmail, expires: Date.now() + 30 * 60 * 1000 });

    const protocol = req.headers['x-forwarded-proto'] || req.protocol || 'https';
    const host = req.headers['x-forwarded-host'] || req.headers.host;
    const resetLink = `${protocol}://${host}/user/reset-password?token=${resetToken}`;

    try { await sendResetPasswordEmail(normalizedEmail, resetLink); } catch (e) {
      console.error("Reset email failed:", e.message);
      return res.status(500).json({ success: false, message: `Email service error: ${e.message}` });
    }
    res.json({ success: true, message: "If this email exists, a password reset link has been sent" });
  } catch (error) {
    console.error("Forgot Password Error:", error.message);
    res.status(500).json({ success: false, message: error.message || "Failed to send reset link" });
  }
});

// GET reset password page
router.get('/reset-password', (req, res) => {
  const { token } = req.query;
  if (!token) return res.status(400).render('404', { message: 'Invalid reset link' });
  const stored = resetTokens.get(token);
  if (!stored) return res.status(400).render('404', { message: 'Reset link not found' });
  if (stored.expires < Date.now()) { resetTokens.delete(token); return res.status(400).render('404', { message: 'Reset link has expired' }); }
  res.render('reset-password', { token, error: null });
});

// POST reset password
router.post('/reset-password', async (req, res) => {
  const { token, newPassword, confirmPassword } = req.body;
  if (!token || !newPassword || !confirmPassword) return res.status(400).json({ success: false, message: "All fields are required" });
  if (newPassword !== confirmPassword) return res.status(400).json({ success: false, message: "Passwords do not match" });
  if (newPassword.length < 6) return res.status(400).json({ success: false, message: "Password must be at least 6 characters" });

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
    res.status(500).json({ success: false, message: error.message || "Failed to reset password" });
  }
});

// Cleanup expired OTPs/tokens every 5 minutes
setInterval(() => {
  const now = Date.now();
  let otpCleaned = 0, tokenCleaned = 0;
  for (const [email, data] of otpStore.entries()) { if (data.expires < now) { otpStore.delete(email); otpCleaned++; } }
  for (const [token, data] of resetTokens.entries()) { if (data.expires < now) { resetTokens.delete(token); tokenCleaned++; } }
  if (otpCleaned > 0 || tokenCleaned > 0) console.log(`Cleanup: Removed ${otpCleaned} expired OTPs, ${tokenCleaned} expired reset tokens`);
}, 5 * 60 * 1000);

module.exports = router;
