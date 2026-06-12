const express = require("express");
const router = express.Router();
const Comment = require("../models/Comment");
const Blog = require("../models/Blog");
const { restrictToLoggedInUserOnly } = require("../middlewares/authentication");
const { validateComment } = require("../middlewares/validation");
const NotificationService = require("../services/notificationService");
const RedisClient = require("../config/redis");

const redis = RedisClient.getInstance();
router.use(restrictToLoggedInUserOnly);

// GET comments for blog
router.get("/blog/:blogId", async (req, res) => {
  try {
    const { blogId } = req.params;
    const { page = 1 } = req.query;
    const limit = 10, skip = (page - 1) * limit;

    const comments = await Comment.find({ blog: blogId, parentComment: null, isDeleted: false })
      .populate("author", "fullName profileImageURL")
      .populate({ path: "replies", populate: { path: "author", select: "fullName profileImageURL" } })
      .sort({ createdAt: -1 }).skip(skip).limit(limit);

    const total = await Comment.countDocuments({ blog: blogId, parentComment: null, isDeleted: false });
    res.json({ success: true, comments, total, pages: Math.ceil(total / limit), currentPage: parseInt(page) });
  } catch (error) {
    console.error("Error fetching comments:", error);
    res.status(500).json({ success: false, message: "Failed to fetch comments" });
  }
});

// POST comment (queue-based)
router.post("/blog/:blogId", async (req, res) => {
  const startTime = Date.now();
  try {
    const { blogId } = req.params;
    const { content, parentCommentId } = req.body;

    if (!content || content.trim().length === 0) return res.status(400).json({ success: false, message: "Content is required" });
    if (content.length > 5000) return res.status(400).json({ success: false, message: "Content exceeds 5000 character limit" });

    const blog = await Blog.findById(blogId).lean();
    if (!blog) return res.status(404).json({ success: false, message: "Blog not found" });

    const commentPayload = {
      userId: req.user._id.toString(),
      blogId,
      content: content.trim(),
      parentCommentId: parentCommentId || null,
      timestamp: new Date().toISOString(),
      ip: req.ip,
      authorName: req.user.fullName
    };

    const queueDepth = await redis.queueComment(commentPayload);

    if (blog.createdBy.toString() !== req.user._id.toString()) {
      try {
        await NotificationService.createNotification(blog.createdBy, "comment", {
          title: "New comment", message: `${req.user.fullName} commented on your blog`, blog: blogId, actor: req.user._id
        });
      } catch (e) { console.error("[Comments] Notification failed:", e.message); }
    }

    res.status(202).json({
      success: true, message: "Comment queued for processing", status: "accepted",
      queuePosition: queueDepth, estimatedDelayMs: Math.ceil(queueDepth / 20) * 500, requestLatencyMs: Date.now() - startTime
    });
  } catch (error) {
    console.error("[Comments] Queue error:", error.message);
    res.status(503).json({ success: false, message: "Comment service temporarily unavailable", retryAfter: 5 });
  }
});

// UPDATE comment (ownership check)
router.put("/:commentId", async (req, res) => {
  try {
    const { commentId } = req.params;
    const { content } = req.body;
    const validation = validateComment(content);
    if (!validation.isValid) return res.status(400).json({ success: false, errors: validation.errors });

    const comment = await Comment.findById(commentId);
    if (!comment) return res.status(404).json({ success: false, message: "Comment not found" });
    if (comment.author.toString() !== req.user._id.toString()) return res.status(403).json({ success: false, message: "Not authorized" });

    comment.content = content.trim();
    await comment.save();
    res.json({ success: true, comment });
  } catch (error) {
    console.error("Error updating comment:", error);
    res.status(500).json({ success: false, message: "Failed to update comment" });
  }
});

// DELETE comment (ownership check)
router.delete("/:commentId", async (req, res) => {
  try {
    const { commentId } = req.params;
    const comment = await Comment.findById(commentId);
    if (!comment) return res.status(404).json({ success: false, message: "Comment not found" });
    if (comment.author.toString() !== req.user._id.toString()) return res.status(403).json({ success: false, message: "Not authorized" });

    comment.isDeleted = true;
    await comment.save();
    res.json({ success: true, message: "Comment deleted" });
  } catch (error) {
    console.error("Error deleting comment:", error);
    res.status(500).json({ success: false, message: "Failed to delete comment" });
  }
});

// LIKE comment
router.post("/:commentId/like", async (req, res) => {
  try {
    const { commentId } = req.params;
    const comment = await Comment.findById(commentId);
    if (!comment) return res.status(404).json({ success: false, message: "Comment not found" });

    const hasLiked = comment.likes.some(id => id.toString() === req.user._id.toString());
    if (hasLiked) {
      comment.likes = comment.likes.filter(id => id.toString() !== req.user._id.toString());
    } else {
      comment.likes.push(req.user._id);
    }
    await comment.save();
    res.json({ success: true, liked: !hasLiked, likeCount: comment.likes.length });
  } catch (error) {
    console.error("Error liking comment:", error);
    res.status(500).json({ success: false, message: "Failed to like comment" });
  }
});

module.exports = router;
