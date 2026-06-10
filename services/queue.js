/**
 * In-memory background job queue with concurrency control.
 * For horizontal scaling or >100 RPS, replace this with BullMQ + Redis.
 */
class BackgroundQueue {
    constructor(concurrency = 5) {
        this.concurrency = concurrency;
        this.running = 0;
        this.queue = [];
    }

    async run(job) {
        this.running++;
        try {
            await job();
        } catch (err) {
            console.error("[Queue] Background job failed:", err.message);
        } finally {
            this.running--;
            this.process();
        }
    }

    process() {
        while (this.running < this.concurrency && this.queue.length > 0) {
            const job = this.queue.shift();
            setImmediate(() => this.run(job));
        }
    }

    add(job) {
        this.queue.push(job);
        this.process();
    }

    size() {
        return this.queue.length + this.running;
    }
}

// Concurrency 5 matches nodemailer pool maxConnections
const emailQueue = new BackgroundQueue(5);

module.exports = { BackgroundQueue, emailQueue };
