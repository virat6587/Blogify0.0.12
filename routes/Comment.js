const express = require('express');
const router = express.Router();
const RedisClient = require('../config/redis');
const Comment = require('../models/Comment');

const redis = RedisClient.getInstance();

router.post('/', async (req, res) => {
  const startTime = Date.now();
  
  try {
    const { userId, blogId, content } = req.body;

    if (!userId || !blogId || !content || content.trim().length === 0) {
      return res.status(400).json({
        success: false,
        message: 'userId, blogId, and content are required'
      });
    }

    if (content.length > 5000) {
      return res.status(400).json({
        success: false,
        message: 'Content exceeds 5000 character limit'
      });
    }

    const commentPayload = {
      userId,
      blogId,
      content: content.trim(),
      timestamp: new Date().toISOString(),
      ip: req.ip
    };

    const queueDepth = await redis.queueComment(commentPayload);
    const latency = Date.now() - startTime;
    
    res.status(202).json({
      success: true,
      message: 'Comment queued for processing',
      status: 'accepted',
      queuePosition: queueDepth,
      estimatedDelayMs: Math.ceil(queueDepth / 20) * 500,
      requestLatencyMs: latency
    });

  } catch (error) {
    console.error('[Comments] Queue error:', error.message);
    res.status(503).json({
      success: false,
      message: 'Comment service temporarily unavailable',
      retryAfter: 5
    });
  }
});

router.get('/blog/:blogId', async (req, res) => {
  try {
    const { blogId } = req.params;
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 20;

    const comments = await Comment.find({ blogId, status: 'active' })
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .populate('userId', 'username avatar');

    const total = await Comment.countDocuments({ blogId, status: 'active' });

    res.json({
      success: true,
      data: comments,
      pagination: {
        page,
        limit,
        total,
        pages: Math.ceil(total / limit)
      }
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

module.exports = router;
