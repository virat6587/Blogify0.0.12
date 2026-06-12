const express = require("express");
const router = express.Router();
const { restrictToLoggedInUserOnly } = require("../middlewares/authentication");
const NotificationService = require("../services/notificationService");

router.use(restrictToLoggedInUserOnly);

// GET notifications
router.get("/", async (req, res) => {
  try {
    const { page = 1 } = req.query;
    const result = await NotificationService.getUserNotifications(req.user._id, 10, page);
    res.json({ success: true, notifications: result.notifications, total: result.total, pages: result.pages, currentPage: parseInt(page) });
  } catch (error) {
    console.error("Error fetching notifications:", error);
    res.status(500).json({ success: false, message: "Failed to fetch notifications" });
  }
});

// GET unread count
router.get("/unread/count", async (req, res) => {
  try {
    const count = await NotificationService.getUnreadCount(req.user._id);
    res.json({ success: true, unreadCount: count });
  } catch (error) {
    console.error("Error getting unread count:", error);
    res.status(500).json({ success: false, message: "Failed to get unread count" });
  }
});

// MARK as read
router.put("/:notificationId/read", async (req, res) => {
  try {
    await NotificationService.markAsRead(req.params.notificationId);
    res.json({ success: true, message: "Marked as read" });
  } catch (error) {
    console.error("Error marking notification as read:", error);
    res.status(500).json({ success: false, message: "Failed to mark as read" });
  }
});

// MARK all as read
router.put("/all/read", async (req, res) => {
  try {
    await NotificationService.markAllAsRead(req.user._id);
    res.json({ success: true, message: "All marked as read" });
  } catch (error) {
    console.error("Error marking all as read:", error);
    res.status(500).json({ success: false, message: "Failed to mark all as read" });
  }
});

module.exports = router;
