const jwt = require("jsonwebtoken");

const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  console.error("FATAL: JWT_SECRET environment variable is required");
  process.exit(1);
}

const createTokenForUser = (user) => {
  const payload = {
    _id: user._id,
    email: user.email,
    fullName: user.fullName,
    profileImageURL: user.profileImageURL,
    role: user.role,
    googleId: user.googleId
  };
  return jwt.sign(payload, JWT_SECRET, { expiresIn: "7d", issuer: "blogify", audience: "blogify-users" });
};

const verifyToken = (token) => {
  return jwt.verify(token, JWT_SECRET, { issuer: "blogify", audience: "blogify-users" });
};

module.exports = { createTokenForUser, verifyToken };
