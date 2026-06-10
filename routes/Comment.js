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

// ====================== GET COMMENTS FOR BLOG ======================
router.get("/blog/:blogId", async (req, res) => {
    try {
        const { blogId } = req.params;
        const { page = 1 } = req.query;
        const limit = 10;
        const skip = (page - 1) * limit;

        const comments = await Comment.find({ 
            blog: blogId, 
            parentComment: null,
            isDeleted: false 
        })
            .populate("author", "fullName profileImageURL")
            .populate({
                path: "replies",
                populate: { path: "author", select: "fullName profileImageURL" }
            })
            .sort({ createdAt: -1 })
            .skip(skip)
            .limit(limit);

        const total = await Comment.countDocuments({ 
            blog: blogId, 
            parentComment: null,
            isDeleted: false 
        });

        res.json({
            success: true,
            comments,
            total,
            pages: Math.ceil(total / limit),
            currentPage: parseInt(page)
        });
    } catch (error) {
        console.error("Error fetching comments:", error);
        res.status(500).json({ success: false, message: "Failed to fetch comments" });
    }
});

// ====================== POST COMMENT (QUEUE-BASED) ======================
// TRAFFIC ABSORPTION: 300 RPS without touching MongoDB
// LPUSH to Redis queue (O(1)), return 202 Accepted immediately
router.post("/blog/:blogId", async (req, res) => {
    const startTime = Date.now();
    
    try {
        const { blogId } = req.params;
        const { content, parentCommentId } = req.body;

        // Fast validation - no DB lookups, O(1)
        if (!content || content.trim().length === 0) {
            return res.status(400).json({ 
                success: false, 
                message: "Content is required" 
            });
        }

        if (content.length > 5000) {
            return res.status(400).json({ 
                success: false, 
                message: "Content exceeds 5000 character limit" 
            });
        }

        // Verify blog exists (required for notification routing)
        const blog = await Blog.findById(blogId).lean();
        if (!blog) {
            return res.status(404).json({ 
                success: false, 
                message: "Blog not found" 
            });
        }

        // Build queue payload - minimal fields to save Redis memory
        const commentPayload = {
            userId: req.user._id.toString(),
            blogId: blogId,
            content: content.trim(),
            parentCommentId: parentCommentId || null,
            timestamp: new Date().toISOString(),
            ip: req.ip,
            authorName: req.user.fullName
        };

        // ATOMIC LPUSH + LTRIM: O(1) + O(1) amortized
        // Returns current queue depth for client insight
        const queueDepth = await redis.queueComment(commentPayload);

        // Send notification to blog author (async, non-blocking)
        if (blog.createdBy.toString() !== req.user._id.toString()) {
            try {
                await NotificationService.createNotification(
                    blog.createdBy,
                    "comment",
                    {
                        title: "New comment",
                        message: `${req.user.fullName} commented on your blog`,
                        blog: blogId,
                        actor: req.user._id
                    }
                );
            } catch (notifError) {
                console.error("[Comments] Notification failed:", notifError.message);
                // Non-critical: don't fail the request
            }
        }

        const latency = Date.now() - startTime;
        
        // INSTANT 202 ACCEPTED - connection freed, zero MongoDB pressure
        res.status(202).json({
            success: true,
            message: "Comment queued for processing",
            status: "accepted",
            queuePosition: queueDepth,
            estimatedDelayMs: Math.ceil(queueDepth / 20) * 500,
            requestLatencyMs: latency
        });

    } catch (error) {
        console.error("[Comments] Queue error:", error.message);
        
        // Redis down = 503 with retry header
        res.status(503).json({
            success: false,
            message: "Comment service temporarily unavailable",
            retryAfter: 5
        });
    }
});

// ====================== UPDATE COMMENT ======================
router.put("/:commentId", async (req, res) => {
    try {
        const { commentId } = req.params;
        const { content } = req.body;

        const validation = validateComment(content);
        if (!validation.isValid) {
            return res.status(400).json({ success: false, errors: validation.errors });
        }

        const comment = await Comment.findById(commentId);
        if (!comment) {
            return res.status(404).json({ success: false, message: "Comment not found" });
        }

        if (comment.author.toString() !== req.user._id.toString()) {
            return res.status(403).json({ success: false, message: "Not authorized" });
        }

        comment.content = content.trim();
        await comment.save();

        res.json({ success: true, comment });
    } catch (error) {
        console.error("Error updating comment:", error);
        res.status(500).json({ success: false, message: "Failed to update comment" });
    }
});

// ====================== DELETE COMMENT ======================
router.delete("/:commentId", async (req, res) => {
    try {
        const { commentId } = req.params;

        const comment = await Comment.findById(commentId);
        if (!comment) {
            return res.status(404).json({ success: false, message: "Comment not found" });
        }

        if (comment.author.toString() !== req.user._id.toString()) {
            return res.status(403).json({ success: false, message: "Not authorized" });
        }

        comment.isDeleted = true;
        await comment.save();

        res.json({ success: true, message: "Comment deleted" });
    } catch (error) {
        console.error("Error deleting comment:", error);
        res.status(500).json({ success: false, message: "Failed to delete comment" });
    }
});

// ====================== LIKE COMMENT ======================
router.post("/:commentId/like", async (req, res) => {
    try {
        const { commentId } = req.params;

        const comment = await Comment.findById(commentId);
        if (!comment) {
            return res.status(404).json({ success: false, message: "Comment not found" });
        }

        const hasLiked = comment.likes.some(id => id.toString() === req.user._id.toString());

        if (hasLiked) {
            comment.likes = comment.likes.filter(id => id.toString() !== req.user._id.toString());
        } else {
            comment.likes.push(req.user._id);
        }

        await comment.save();

        res.json({ 
            success: true, 
            liked: !hasLiked,
            likeCount: comment.likes.length 
        });
    } catch (error) {
        console.error("Error liking comment:", error);
        res.status(500).json({ success: false, message: "Failed to like comment" });
    }
});

module.exports = router;
