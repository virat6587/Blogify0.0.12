const mongoose = require("mongoose");
const { Schema, model } = mongoose;

const CommentSchema = new Schema({
  content: { type: String, required: true, minlength: 1, maxlength: 5000 },
  blog: { type: Schema.Types.ObjectId, ref: "blog", required: true },
  author: { type: Schema.Types.ObjectId, ref: "user", required: true },
  parentComment: { type: Schema.Types.ObjectId, ref: "Comment", default: null },
  replies: [{ type: Schema.Types.ObjectId, ref: "Comment" }],
  likes: [{ type: Schema.Types.ObjectId, ref: "user" }],
  isApproved: { type: Boolean, default: true },
  isDeleted: { type: Boolean, default: false },
}, { timestamps: true });

CommentSchema.index({ blog: 1, isDeleted: 1 });
CommentSchema.index({ author: 1 });

CommentSchema.virtual("likeCount").get(function() { return this.likes?.length || 0; });

CommentSchema.query.notDeleted = function() { return this.where({ isDeleted: false }); };
CommentSchema.query.approved = function() { return this.where({ isApproved: true }); };

const Comment = mongoose.models.Comment || model("Comment", CommentSchema);
module.exports = Comment;
