// routes/GoogleAuthentication.js
const { Router } = require("express");
const passport = require("passport");
const User = require("../models/user");
const { creatTokenForUser } = require("../services/authentication");

const router = Router();

// ====================== GOOGLE STRATEGY ======================
const GoogleStrategy = require("passport-google-oauth20").Strategy;

if (process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET) {
    passport.use(
        "google",
        new GoogleStrategy(
            {
                clientID: process.env.GOOGLE_CLIENT_ID,
                clientSecret: process.env.GOOGLE_CLIENT_SECRET,
                callbackURL: process.env.GOOGLE_CALLBACK_URL,
            },
            async (accessToken, refreshToken, profile, done) => {
                try {
                    const user = await User.findOrCreateGoogleUser(profile);
                    return done(null, user);
                } catch (err) {
                    console.error("Google Strategy Error:", err);
                    return done(err);
                }
            }
        )
    );
}

// Serialize / Deserialize (Required for Passport sessions)
passport.serializeUser((user, done) => done(null, user.id));
passport.deserializeUser(async (id, done) => {
    try {
        const user = await User.findById(id);
        done(null, user);
    } catch (err) {
        done(err);
    }
});

// ====================== GOOGLE ROUTES ======================
router.get("/auth/google", passport.authenticate("google", { scope: ["profile", "email"] }));

router.get("/auth/google/callback",
    passport.authenticate("google", { 
        failureRedirect: "/user/signin",
        session: false 
    }),
    (req, res) => {
        if (!req.user) return res.redirect("/user/signin");

        const token = creatTokenForUser(req.user);

        res.cookie("token", token, {
            httpOnly: true,
            secure: process.env.NODE_ENV === "production",
            sameSite: "lax",
            maxAge: 7 * 24 * 60 * 60 * 1000
        });

        res.redirect("/?auth=success");
    }
);

module.exports = router;
