const mongoose = require("mongoose");
const { Schema, model } = mongoose;

const BlogSchema = new Schema({
  title: { type: String, required: true, trim: true, maxlength: 200 },
  body: { type: String, required: true },
  slug: { type: String, unique: true, sparse: true },
  excerpt: { type: String, default: "", maxlength: 1000 },
  metaDescription: { type: String, default: "", maxlength: 500 },
  coverImageURL: { type: String, default: null },
  tags: [{ type: String, trim: true, maxlength: 50 }],
  category: { type: String, default: "General", maxlength: 100 },
  status: { type: String, enum: ["published", "draft"], default: "published" },
  createdBy: { type: Schema.Types.ObjectId, ref: "user", required: true },
  isDeleted: { type: Boolean, default: false },
  deletedAt: { type: Date, default: null },
  isFeatured: { type: Boolean, default: false },
  featuredRank: { type: Number, default: 0 },
  viewCount: { type: Number, default: 0, min: 0 },
  likes: [{ type: Schema.Types.ObjectId, ref: "user" }],
  readingTime: { type: Number, default: 0 },
  viewers: [{
    viewerId: { type: String, required: true, maxlength: 128 },
    viewedAt: { type: Date, required: true },
    isAuthenticated: { type: Boolean, default: false }
  }]
}, { timestamps: true });

BlogSchema.query.notDeleted = function() { return this.where({ isDeleted: false }); };

BlogSchema.index({ createdBy: 1, createdAt: -1 });
BlogSchema.index({ tags: 1 });
BlogSchema.index({ status: 1, isDeleted: 1, createdAt: -1 });
BlogSchema.index({ isFeatured: 1, featuredRank: 1 });
BlogSchema.index({ viewCount: -1 });
BlogSchema.index({ "viewers.viewerId": 1, "viewers.viewedAt": 1 });

BlogSchema.pre("save", function(next) {
  if (this.isModified("body")) {
    const wordsPerMinute = 200;
    const wordCount = this.body.trim().split(/\s+/).length;
    this.readingTime = Math.ceil(wordCount / wordsPerMinute);
  }
  next();
});

const Blog = mongoose.models.blog || model("blog", BlogSchema);
module.exports = Blog;
