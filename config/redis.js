const redis = require('redis');

// ─── MEMORY OPTIMIZATION FOR 30MB FREE TIER ───
const MAX_QUEUE_LENGTH = 5000;
const REDIS_MAX_RETRIES = 10;
const REDIS_RETRY_BASE_MS = 1000;

class RedisClient {
  constructor() {
    this.client = null;
    this.isConnected = false;
    this.retryCount = 0;
    
    this.keys = {
      COMMENT_QUEUE: 'queue:comments',
      BLOG_CACHE_PREFIX: 'cache:blog:',
      WORKER_LOCK: 'lock:comment-worker',
      STATS: 'stats:comments'
    };
  }

  async connect() {
    try {
      this.client = redis.createClient({
        url: process.env.REDIS_URL || 'redis://localhost:6379',
        socket: {
          reconnectStrategy: (retries) => {
            const delay = Math.min(
              REDIS_RETRY_BASE_MS * Math.pow(2, retries),
              30000
            );
            console.log(`[Redis] Reconnect attempt ${retries + 1}/${REDIS_MAX_RETRIES} in ${delay}ms`);
            return delay;
          },
          connectTimeout: 10000,
          keepAlive: true,
        },
        disableOfflineQueue: true,
      });

      this.client.on('connect', () => {
        console.log('[Redis] Socket connected');
      });

      this.client.on('ready', () => {
        this.isConnected = true;
        this.retryCount = 0;
        console.log('[Redis] Client ready - commands accepted');
      });

      this.client.on('error', (err) => {
        console.error('[Redis] Client error:', err.message);
      });

      this.client.on('reconnecting', () => {
        this.retryCount++;
        if (this.retryCount > REDIS_MAX_RETRIES) {
          console.error('[Redis] Max retries exceeded. Entering degraded mode.');
        }
      });

      this.client.on('end', () => {
        this.isConnected = false;
        console.log('[Redis] Connection closed');
      });

      await this.client.connect();
      await this.client.ping();
      console.log('[Redis] Connection verified (PONG)');
      
      return this.client;
    } catch (error) {
      console.error('[Redis] Initial connection failed:', error.message);
      return null;
    }
  }

  async queueComment(commentPayload) {
    if (!this.isConnected) {
      throw new Error('Redis unavailable - comment rejected');
    }

    const pipeline = this.client.multi();
    pipeline.lPush(this.keys.COMMENT_QUEUE, JSON.stringify(commentPayload));
    pipeline.lTrim(this.keys.COMMENT_QUEUE, 0, MAX_QUEUE_LENGTH - 1);
    pipeline.hIncrBy(this.keys.STATS, 'queued', 1);
    
    await pipeline.exec();
    const depth = await this.client.lLen(this.keys.COMMENT_QUEUE);
    return depth;
  }

  async popComment(timeoutSeconds = 5) {
    if (!this.isConnected) return null;
    
    const result = await this.client.brPopLPush(
      this.keys.COMMENT_QUEUE,
      `${this.keys.COMMENT_QUEUE}:processing`,
      timeoutSeconds
    );
    
    return result ? JSON.parse(result) : null;
  }

  async ackComment(commentPayload) {
    if (!this.isConnected) return;
    await this.client.lRem(
      `${this.keys.COMMENT_QUEUE}:processing`,
      0,
      JSON.stringify(commentPayload)
    );
  }

  async cacheBlog(blogId, blogData, ttlSeconds = 300) {
    if (!this.isConnected) return false;
    const key = `${this.keys.BLOG_CACHE_PREFIX}${blogId}`;
    const compressed = JSON.stringify({
      _id: blogData._id,
      title: blogData.title,
      body: blogData.body,
      author: blogData.author,
      tags: blogData.tags,
      likes: blogData.likes,
      viewCount: blogData.viewCount,
      createdAt: blogData.createdAt,
      readingTime: blogData.readingTime,
      coverImageURL: blogData.coverImageURL,
      excerpt: blogData.excerpt,
      metaDescription: blogData.metaDescription,
      category: blogData.category,
      status: blogData.status,
      isFeatured: blogData.isFeatured,
      featuredRank: blogData.featuredRank,
      slug: blogData.slug
    });
    await this.client.setEx(key, ttlSeconds, compressed);
    return true;
  }

  async getCachedBlog(blogId) {
    if (!this.isConnected) return null;
    const key = `${this.keys.BLOG_CACHE_PREFIX}${blogId}`;
    const data = await this.client.get(key);
    return data ? JSON.parse(data) : null;
  }

  async invalidateBlogCache(blogId) {
    if (!this.isConnected) return;
    const key = `${this.keys.BLOG_CACHE_PREFIX}${blogId}`;
    await this.client.del(key);
  }

  async disconnect() {
    if (this.client) {
      await this.client.quit();
      this.isConnected = false;
    }
  }

  static getInstance() {
    if (!RedisClient.instance) {
      RedisClient.instance = new RedisClient();
    }
    return RedisClient.instance;
  }
}

module.exports = RedisClient;
