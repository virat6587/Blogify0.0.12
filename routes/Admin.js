const express = require("express");
const router = express.Router();
const User = require("../models/user");
const Blog = require("../models/Blog");
const { restrictTo } = require("../middlewares/authentication");
const { validateObjectId } = require("../middlewares/validation");

router.use(restrictTo(["ADMIN"]));

router.get("/users", async (req, res) => {
  try {
    const users = await User.find({}).select("fullName email profileImageURL role createdAt").sort({ createdAt: -1 }).lean();
    const usersWithBlogs = await Promise.all(users.map(async (user) => {
      const blogs = await Blog.find({ createdBy: user._id }).select("title coverImageURL createdAt").sort({ createdAt: -1 }).lean();
      return { ...user, blogCount: blogs.length, blogs };
    }));
    res.render("admin/users", { user: req.user, users: usersWithBlogs });
  } catch (error) { console.error("Admin Users Error:", error); res.status(500).send("Server Error"); }
});

router.delete("/users/:id", async (req, res) => {
  try {
    const userId = req.params.id;
    if (!validateObjectId(userId)) return res.status(400).json({ success: false, message: "Invalid user ID" });
    if (userId === req.user._id.toString()) return res.status(400).json({ success: false, message: "You cannot delete yourself" });
    await Blog.deleteMany({ createdBy: userId });
    await User.findByIdAndDelete(userId);
    res.json({ success: true, message: "User and all their blogs deleted successfully" });
  } catch (error) { console.error(error); res.status(500).json({ success: false, message: "Failed to delete user" }); }
});

module.exports = router;
