const RedisClient = require('../config/redis');
const Comment = require('../models/Comment');

class CommentWorker {
  constructor() {
    this.redis = RedisClient.getInstance();
    this.isRunning = false;
    this.batchSize = 10;
    this.maxWritesPerSecond = 20;
    this.sleepBetweenBatches = 500;
    this.processedCount = 0;
    this.failedCount = 0;
  }

  async start() {
    if (this.isRunning) {
      console.log('[Worker] Already running');
      return;
    }
    
    this.isRunning = true;
    console.log('[Worker] Started - Throttle: 20 ops/sec, Batch: 10, Target: 300 RPS absorption');
    
    while (this.isRunning) {
      try {
        const batch = await this.collectBatch();
        
        if (batch.length === 0) {
          await this.sleep(100);
          continue;
        }
        
        await this.processBatch(batch);
        await this.sleep(this.sleepBetweenBatches);
        
      } catch (error) {
        console.error('[Worker] Fatal loop error:', error.message);
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
      const parsed = JSON.parse(item);
      batch.push(parsed);
      await this.redis.ackComment(parsed);
    }
    
    return batch;
  }

  async processBatch(batch) {
    const startTime = Date.now();
    
    try {
      const comments = batch.map(item => ({
        userId: item.userId,
        blogId: item.blogId,
        content: item.content,
        createdAt: item.timestamp || new Date(),
        status: 'active',
        likes: [],
        replies: [],
        isEdited: false,
        ingestedAt: new Date(),
        queueLatencyMs: Date.now() - new Date(item.timestamp).getTime()
      }));

      const result = await Comment.insertMany(comments, {
        ordered: false,
        rawResult: true
      });

      for (const item of batch) {
        await this.redis.ackComment(item);
      }

      this.processedCount += result.insertedCount || batch.length;
      const duration = Date.now() - startTime;
      const queueDepth = await this.redis.client.lLen(this.redis.keys.COMMENT_QUEUE);
      
      console.log(
        `[Worker] Batch OK: ${result.insertedCount || batch.length} comments ` +
        `in ${duration}ms | Total: ${this.processedCount} | Queue depth: ${queueDepth}`
      );

    } catch (error) {
      console.error('[Worker] Batch insert failed:', error.message);
      this.failedCount += batch.length;
      
      if (this.failedCount > 100 && this.failedCount % 100 === 0) {
        console.error(`[Worker] ALERT: ${this.failedCount} failed comments accumulated`);
      }
    }
  }

  stop() {
    this.isRunning = false;
    console.log('[Worker] Stop signal received');
  }

  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  getStats() {
    return {
      processed: this.processedCount,
      failed: this.failedCount,
      isRunning: this.isRunning,
      batchSize: this.batchSize,
      throttleMs: this.sleepBetweenBatches
    };
  }
}

module.exports = new CommentWorker();
