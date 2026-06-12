const Notification = require("../models/Notification");
const User = require("../models/user");

class NotificationService {
  static async createNotification(recipientId, type, { title, message, blog, actor }) {
    try {
      const recipient = await User.findById(recipientId).select("notificationSettings");
      if (!recipient) return null;
      const notification = await Notification.create({
        recipient: recipientId,
        type,
        title: String(title || "").substring(0, 200),
        message: String(message || "").substring(0, 1000),
        blog: blog || null,
        actor: actor || null
      });
      return notification;
    } catch (error) {
      console.error("[NotificationService] Create failed:", error.message);
      return null;
    }
  }

  static async getUserNotifications(userId, limit = 10, page = 1) {
    try {
      const skip = (parseInt(page) - 1) * limit;
      const [notifications, total] = await Promise.all([
        Notification.find({ recipient: userId }).sort({ createdAt: -1 }).skip(skip).limit(parseInt(limit)).populate("actor", "fullName profileImageURL").lean(),
        Notification.countDocuments({ recipient: userId })
      ]);
      return { notifications, total, pages: Math.ceil(total / limit) };
    } catch (error) {
      console.error("[NotificationService] Get failed:", error.message);
      return { notifications: [], total: 0, pages: 0 };
    }
  }

  static async getUnreadCount(userId) {
    try {
      return await Notification.countDocuments({ recipient: userId, isRead: false });
    } catch (error) {
      console.error("[NotificationService] Unread count failed:", error.message);
      return 0;
    }
  }

  static async markAsRead(notificationId) {
    try {
      await Notification.findByIdAndUpdate(notificationId, { isRead: true });
    } catch (error) {
      console.error("[NotificationService] Mark read failed:", error.message);
    }
  }

  static async markAllAsRead(userId) {
    try {
      await Notification.updateMany({ recipient: userId, isRead: false }, { isRead: true });
    } catch (error) {
      console.error("[NotificationService] Mark all read failed:", error.message);
    }
  }
}

module.exports = NotificationService;
