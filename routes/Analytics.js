const express = require("express");
const router = express.Router();
const { restrictToLoggedInUserOnly, restrictTo } = require("../middlewares/authentication");
const AnalyticsService = require("../services/analyticsService");
const Blog = require("../models/Blog");

// PUBLIC: Trending blogs (sanitized - no sensitive data)
router.get("/trending", async (req, res) => {
  try {
    const { limit = 5 } = req.query;
    const blogs = await AnalyticsService.getTrendingBlogs(parseInt(limit));
    // Sanitize: remove internal IDs, viewer fingerprints, etc.
    const sanitized = blogs.map(b => ({
      title: b.blog?.title,
      slug: b.blog?.slug,
      coverImageURL: b.blog?.coverImageURL,
      authorName: b.blog?.createdBy?.fullName,
      totalViews: b.totalViews,
      totalLikes: b.totalLikes,
      totalComments: b.totalComments
    }));
    res.json({ success: true, blogs: sanitized });
  } catch (error) {
    console.error("Trending error:", error);
    res.status(500).json({ success: false, message: "Failed to fetch trending blogs" });
  }
});

// PUBLIC: Most liked blogs (sanitized)
router.get("/most-liked", async (req, res) => {
  try {
    const { limit = 5 } = req.query;
    const blogs = await AnalyticsService.getMostLikedBlogs(parseInt(limit));
    const sanitized = blogs.map(b => ({
      title: b.blog?.title,
      slug: b.blog?.slug,
      coverImageURL: b.blog?.coverImageURL,
      authorName: b.blog?.createdBy?.fullName,
      totalViews: b.totalViews,
      totalLikes: b.totalLikes
    }));
    res.json({ success: true, blogs: sanitized });
  } catch (error) {
    console.error("Most liked error:", error);
    res.status(500).json({ success: false, message: "Failed to fetch most liked blogs" });
  }
});

// PROTECTED: Blog analytics (owner or admin only)
router.get("/blog/:blogId", restrictToLoggedInUserOnly, async (req, res) => {
  try {
    const { blogId } = req.params;
    const blog = await Blog.findById(blogId).lean();
    if (!blog) return res.status(404).json({ success: false, message: "Blog not found" });

    const isOwner = blog.createdBy?.toString() === req.user._id.toString();
    const isAdmin = req.user.role === "ADMIN";
    if (!isOwner && !isAdmin) {
      return res.status(403).json({ success: false, message: "Access denied" });
    }

    const analytics = await AnalyticsService.getBlogAnalytics(blogId);
    if (!analytics) return res.status(404).json({ success: false, message: "No analytics found" });

    res.json({ success: true, analytics });
  } catch (error) {
    console.error("Blog analytics error:", error);
    res.status(500).json({ success: false, message: "Failed to fetch blog analytics" });
  }
});

// PROTECTED: Author stats (own stats only)
router.get("/author/stats", restrictToLoggedInUserOnly, async (req, res) => {
  try {
    const stats = await AnalyticsService.getAuthorAnalytics(req.user._id);
    res.json({ success: true, stats });
  } catch (error) {
    console.error("Author stats error:", error);
    res.status(500).json({ success: false, message: "Failed to fetch author analytics" });
  }
});

// ADMIN ONLY: Full platform analytics
router.get("/admin/dashboard", restrictToLoggedInUserOnly, restrictTo(["ADMIN"]), async (req, res) => {
  try {
    const User = require("../models/user");
    const Comment = require("../models/Comment");
    const totalUsers = await User.countDocuments();
    const totalBlogs = await Blog.countDocuments({ isDeleted: false });
    const totalComments = await Comment.countDocuments({ isDeleted: false });

    const platformStats = await require("../models/BlogAnalytics").aggregate([
      { $group: { _id: null, totalViews: { $sum: "$totalViews" }, totalLikes: { $sum: "$totalLikes" } } }
    ]);

    res.json({
      success: true,
      stats: { totalUsers, totalBlogs, totalComments, platform: platformStats[0] || {} }
    });
  } catch (error) {
    console.error("Admin analytics error:", error);
    res.status(500).json({ success: false, message: "Failed to fetch admin analytics" });
  }
});

module.exports = router;
