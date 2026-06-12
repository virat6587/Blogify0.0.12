const mongoose = require("mongoose");
const { Schema, model } = mongoose;

const NotificationSchema = new Schema({
  recipient: { type: Schema.Types.ObjectId, ref: "user", required: true },
  type: { type: String, enum: ["comment", "reply", "like", "follow", "mention"], required: true },
  title: { type: String, maxlength: 200 },
  message: { type: String, maxlength: 1000 },
  blog: { type: Schema.Types.ObjectId, ref: "blog" },
  actor: { type: Schema.Types.ObjectId, ref: "user" },
  isRead: { type: Boolean, default: false },
}, { timestamps: true });

NotificationSchema.index({ recipient: 1, isRead: 1 });
NotificationSchema.index({ createdAt: -1 });

const Notification = mongoose.models.Notification || model("Notification", NotificationSchema);
module.exports = Notification;
