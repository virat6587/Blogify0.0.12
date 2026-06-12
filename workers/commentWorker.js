const RedisClient = require("../config/redis");
const Comment = require("../models/Comment");
const mongoose = require("mongoose");

class CommentWorker {
  constructor() {
    this.redis = RedisClient.getInstance();
    this.isRunning = false;
    this.batchSize = 10;
    this.sleepBetweenBatches = 500;
    this.processedCount = 0;
    this.failedCount = 0;
  }

  async start() {
    if (this.isRunning) { console.log("[Worker] Already running"); return; }
    this.isRunning = true;
    console.log("[Worker] Started");
    while (this.isRunning) {
      try {
        const batch = await this.collectBatch();
        if (batch.length === 0) { await this.sleep(100); continue; }
        await this.processBatch(batch);
        await this.sleep(this.sleepBetweenBatches);
      } catch (error) {
        console.error("[Worker] Fatal loop error:", error.message);
        await this.sleep(5000);
      }
    }
  }

  async collectBatch() {
    const batch = [];
    const first = await this.redis.popComment(5);
    if (!first) return batch;
    batch.push(first);
    for (let i = 1; i < this.batchSize; i++) {
      const item = await this.redis.client.rPop(this.redis.keys.COMMENT_QUEUE);
      if (!item) break;
      try {
        const parsed = JSON.parse(item);
        batch.push(parsed);
        await this.redis.ackComment(parsed);
      } catch (e) { console.error("[Worker] Failed to parse queued comment:", e.message); }
    }
    return batch;
  }

  async processBatch(batch) {
    const startTime = Date.now();
    try {
      const comments = batch.map(item => ({
        content: String(item.content || "").substring(0, 5000),
        blog: new mongoose.Types.ObjectId(item.blogId),
        author: new mongoose.Types.ObjectId(item.userId),
        parentComment: item.parentCommentId ? new mongoose.Types.ObjectId(item.parentCommentId) : null,
        createdAt: new Date(item.timestamp || Date.now()),
        likes: [],
        replies: [],
        isApproved: true,
        isDeleted: false,
        ingestedAt: new Date(),
        queueLatencyMs: Date.now() - new Date(item.timestamp || Date.now()).getTime()
      }));

      const result = await Comment.insertMany(comments, { ordered: false });
      for (const item of batch) await this.redis.ackComment(item);
      this.processedCount += result.insertedCount || batch.length;
      console.log(`[Worker] Batch OK: ${result.insertedCount || batch.length} comments in ${Date.now() - startTime}ms | Total: ${this.processedCount}`);
    } catch (error) {
      console.error("[Worker] Batch insert failed:", error.message);
      this.failedCount += batch.length;
      if (this.failedCount > 100 && this.failedCount % 100 === 0) {
        console.error(`[Worker] ALERT: ${this.failedCount} failed comments accumulated`);
      }
    }
  }

  stop() { this.isRunning = false; console.log("[Worker] Stop signal received"); }
  sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
  getStats() { return { processed: this.processedCount, failed: this.failedCount, isRunning: this.isRunning }; }
}

module.exports = new CommentWorker();
