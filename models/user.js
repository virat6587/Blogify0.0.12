const mongoose = require("mongoose");
const { Schema, model } = mongoose;
const bcrypt = require("bcrypt");
const { createTokenForUser } = require("../services/authentication");

const SALT_ROUNDS = 12;

const UserSchema = new Schema({
  fullName: { type: String, required: true, trim: true, maxlength: 100 },
  email: { type: String, required: true, unique: true, lowercase: true, trim: true, match: /^[^\s@]+@[^\s@]+\.[^\s@]+$/ },
  password: { type: String, minlength: 6 },
  googleId: { type: String, unique: true, sparse: true },
  profileImageURL: { type: String, default: "/imgs/default.png" },
  bio: { type: String, default: "", maxlength: 500 },
  website: { type: String, default: "" },
  location: { type: String, default: "", maxlength: 100 },
  role: { type: String, enum: ["USER", "ADMIN"], default: "USER" },
  theme: { type: String, enum: ["light", "dark"], default: "light" },
  followers: [{ type: Schema.Types.ObjectId, ref: "user" }],
  following: [{ type: Schema.Types.ObjectId, ref: "user" }],
  notificationSettings: {
    emailOnComment: { type: Boolean, default: true },
    emailOnNewFollower: { type: Boolean, default: true },
    emailDigest: { type: Boolean, default: true }
  },
}, { timestamps: true });

UserSchema.index({ followers: 1 });
UserSchema.index({ following: 1 });

UserSchema.virtual("followerCount").get(function() { return this.followers ? this.followers.length : 0; });
UserSchema.virtual("followingCount").get(function() { return this.following ? this.following.length : 0; });

UserSchema.pre("save", async function(next) {
  if (!this.password || !this.isModified("password") || this.googleId) return next();
  this.password = await bcrypt.hash(this.password, SALT_ROUNDS);
  next();
});

UserSchema.static("matchPassword", async function(email, password) {
  const user = await this.findOne({ email: email.toLowerCase() }).lean().select("_id email fullName profileImageURL role googleId password");
  if (!user) throw new Error("Invalid email or password");
  if (!user.password) throw new Error("This account uses Google Sign-In");
  const isMatch = await bcrypt.compare(password, user.password);
  if (!isMatch) throw new Error("Invalid email or password");
  return createTokenForUser(user);
});

UserSchema.static("findOrCreateGoogleUser", async function(profile) {
  try {
    const email = profile.emails?.[0]?.value?.toLowerCase();
    const googleId = profile.id;
    if (!email) throw new Error("Google profile missing email");
    let user = await this.findOne({ googleId });
    if (!user) {
      user = await this.findOne({ email });
      if (user) {
        user.googleId = googleId;
        if (profile.photos?.[0]?.value) user.profileImageURL = profile.photos[0].value;
        await user.save();
      } else {
        user = await this.create({
          fullName: profile.displayName?.trim() || "Google User",
          email: email,
          googleId: googleId,
          profileImageURL: profile.photos?.[0]?.value || "/imgs/default.png"
        });
      }
    }
    return user;
  } catch (error) {
    console.error("findOrCreateGoogleUser Error:", error.message);
    throw error;
  }
});

UserSchema.methods.followUser = async function(userId) {
  if (!this.following.includes(userId)) { this.following.push(userId); await this.save(); }
};

UserSchema.methods.unfollowUser = async function(userId) {
  this.following = this.following.filter(id => id.toString() !== userId.toString());
  await this.save();
};

UserSchema.methods.isFollowing = function(userId) {
  return this.following.some(id => id.toString() === userId.toString());
};

UserSchema.methods.addFollower = async function(userId) {
  if (!this.followers.includes(userId)) { this.followers.push(userId); await this.save(); }
};

UserSchema.methods.removeFollower = async function(userId) {
  this.followers = this.followers.filter(id => id.toString() !== userId.toString());
  await this.save();
};

const User = mongoose.models.user || model("user", UserSchema);
module.exports = User;
