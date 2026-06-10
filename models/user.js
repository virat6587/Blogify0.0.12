const mongoose = require("mongoose");
const { Schema, model } = mongoose;
const bcrypt = require("bcrypt");
const { creatTokenForUser } = require("../services/authentication");

// Tuned for 50 RPS: ~50-100ms per hash, non-blocking via libuv thread pool
const SALT_ROUNDS = 10;

const UserSchema = new Schema({
    fullName: { 
        type: String, 
        required: true,
        trim: true 
    },
    email: { 
        type: String, 
        required: true, 
        unique: true,
        lowercase: true,
        trim: true
    },
    password: { type: String },
    googleId: { 
        type: String, 
        unique: true, 
        sparse: true 
    },
    profileImageURL: { 
        type: String, 
        default: "/imgs/default.png" 
    },
    
    bio: { 
        type: String, 
        default: "", 
        maxlength: 500 
    },
    website: { 
        type: String, 
        default: "" 
    },
    
    role: { 
        type: String, 
        enum: ["USER", "ADMIN"], 
        default: "USER" 
    },
    
    theme: {
        type: String,
        enum: ["light", "dark"],
        default: "light"
    },
    
    followers: [{ 
        type: Schema.Types.ObjectId, 
        ref: "user" 
    }],
    following: [{ 
        type: Schema.Types.ObjectId, 
        ref: "user" 
    }],
    
    notificationSettings: {
        emailOnComment: { type: Boolean, default: true },
        emailOnNewFollower: { type: Boolean, default: true },
        emailDigest: { type: Boolean, default: true }
    },
    
}, { timestamps: true });

// Only non-redundant indexes (unique: true on email already creates it)
UserSchema.index({ followers: 1 });
UserSchema.index({ following: 1 });

// ====================== VIRTUALS ======================
UserSchema.virtual("followerCount").get(function() {
    return this.followers ? this.followers.length : 0;
});

UserSchema.virtual("followingCount").get(function() {
    return this.following ? this.following.length : 0;
});

// ====================== PASSWORD HASHING (async bcrypt) ======================
UserSchema.pre("save", async function() {
    if (!this.password || !this.isModified("password") || this.googleId) return;
    this.password = await bcrypt.hash(this.password, SALT_ROUNDS);
});

// ====================== STATIC METHODS ======================
UserSchema.static("matchPassword", async function (email, password) {
    const user = await this.findOne({ email: email.toLowerCase() })
        .lean()
        .select("_id email fullName profileImageURL role googleId password");
    
    if (!user) throw new Error("User not found");
    if (!user.password) throw new Error("This account uses Google Sign-In");

    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) throw new Error("Incorrect Password");

    return creatTokenForUser(user);
});

UserSchema.static("findOrCreateGoogleUser", async function (profile) {
    try {
        const email = profile.emails[0].value.toLowerCase();
        const googleId = profile.id;

        let user = await this.findOne({ googleId });

        if (!user) {
            user = await this.findOne({ email });

            if (user) {
                user.googleId = googleId;
                if (profile.photos?.[0]?.value) {
                    user.profileImageURL = profile.photos[0].value;
                }
                await user.save();
            } else {
                user = await this.create({
                    fullName: profile.displayName || "Google User",
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

// ====================== FOLLOW METHODS ======================
UserSchema.methods.followUser = async function(userId) {
    if (!this.following.includes(userId)) {
        this.following.push(userId);
        await this.save();
    }
};

UserSchema.methods.unfollowUser = async function(userId) {
    this.following = this.following.filter(id => id.toString() !== userId.toString());
    await this.save();
};

UserSchema.methods.isFollowing = function(userId) {
    return this.following.some(id => id.toString() === userId.toString());
};

UserSchema.methods.addFollower = async function(userId) {
    if (!this.followers.includes(userId)) {
        this.followers.push(userId);
        await this.save();
    }
};

UserSchema.methods.removeFollower = async function(userId) {
    this.followers = this.followers.filter(id => id.toString() !== userId.toString());
    await this.save();
};

// ====================== CREATE MODEL ======================
const User = mongoose.models.user || model("user", UserSchema);

module.exports = User;
