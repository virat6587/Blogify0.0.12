const express = require("express");
const router = express.Router();
const Blog = require("../models/Blog");
const { restrictToLoggedInUserOnly } = require("../middlewares/authentication");
const { blogCreationLimiter, likeLimiter } = require("../middlewares/rateLimiting");
const cloudinaryUpload = require("../middlewares/CloudinaryUploads");
const { validateBlog, validateObjectId } = require("../middlewares/validation");
const AnalyticsService = require("../services/analyticsService");
const NotificationService = require("../services/notificationService");
const RedisClient = require("../config/redis");

const redis = RedisClient.getInstance();

// Public routes
router.get("/featured/list", async (req, res) => {
  try {
    const blogs = await Blog.find({ isFeatured: true, status: "published", isDeleted: false })
      .sort({ featuredRank: 1, createdAt: -1 }).populate("createdBy", "fullName profileImageURL").lean();
    res.json({ success: true, blogs });
  } catch (error) { console.error("Featured blogs error:", error); res.status(500).json({ success: false, message: "Failed to fetch featured blogs" }); }
});

router.get("/tags/:tag", async (req, res) => {
  try {
    const { tag } = req.params;
    const { page = 1 } = req.query;
    const limit = 9, skip = (parseInt(page) - 1) * limit;
    const blogs = await Blog.find({ tags: tag, status: "published", isDeleted: false })
      .sort({ createdAt: -1 }).skip(skip).limit(limit).populate("createdBy", "fullName profileImageURL").lean();
    const total = await Blog.countDocuments({ tags: tag, status: "published", isDeleted: false });
    res.render("taggedBlogs", { user: req.user, blogs, tag, currentPage: parseInt(page), totalPages: Math.ceil(total / limit) });
  } catch (error) { console.error("Tagged blogs error:", error); res.status(500).send("Internal Server Error"); }
});

router.get("/:id", async (req, res) => {
  const { id } = req.params;
  if (!validateObjectId(id)) return res.status(400).send("Invalid blog ID");
  try {
    const cached = await redis.getCachedBlog(id);
    if (cached) {
      return res.render("view", {
        user: req.user, blog: cached, relatedBlogs: [], authorBlogs: [],
        hasLiked: req.user ? cached.likes.some(likeId => likeId.toString() === req.user._id.toString()) : false, source: "cache"
      });
    }
    const blog = await Blog.findById(id).notDeleted().populate("createdBy", "fullName profileImageURL bio followers").lean();
    if (!blog) return res.status(404).send("Blog not found");

    const viewerId = req.user ? req.user._id.toString() : req.ip;
    const userAgent = req.headers["user-agent"] || "";
    const viewerFingerprint = req.user ? viewerId : `${viewerId}_${Buffer.from(userAgent).toString("base64").substring(0, 16)}`;
    const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);

    const existingView = await Blog.findOne({
      _id: blog._id,
      viewers: { $elemMatch: { viewerId: viewerFingerprint, viewedAt: { $gte: twentyFourHoursAgo } } }
    });

    if (!existingView) {
      await Blog.findByIdAndUpdate(blog._id, { $pull: { viewers: { viewerId: viewerFingerprint } } });
      await Blog.findByIdAndUpdate(blog._id, {
        $push: { viewers: { viewerId: viewerFingerprint, viewedAt: new Date(), isAuthenticated: !!req.user } },
        $inc: { viewCount: 1 }
      });
      await AnalyticsService.trackView(blog._id, req.user?._id, "direct");
    }

    const updatedBlog = await Blog.findById(id).notDeleted().populate("createdBy", "fullName profileImageURL bio followers").lean();
    const relatedBlogs = await Blog.find({ tags: { $in: blog.tags }, _id: { $ne: blog._id }, isDeleted: false, status: "published" }).limit(3).lean();
    const authorBlogs = await Blog.find({ createdBy: blog.createdBy._id, _id: { $ne: blog._id }, isDeleted: false, status: "published" }).limit(3).lean();
    const hasLiked = req.user ? updatedBlog.likes.some(lid => lid.toString() === req.user._id.toString()) : false;

    await redis.cacheBlog(id, updatedBlog, 300);
    res.render("view", { user: req.user, blog: updatedBlog, relatedBlogs, authorBlogs, hasLiked, source: "database" });
  } catch (error) { console.error("Single Blog Error:", error); res.status(500).send("Internal Server Error"); }
});

// Protected routes
router.use(restrictToLoggedInUserOnly);

router.get("/add-new", (req, res) => { res.render("addBlog", { user: req.user, error: null }); });

router.post("/add-new", blogCreationLimiter, cloudinaryUpload.single("coverImage"), async (req, res) => {
  try {
    const { title, body, tags, category, status, metaDescription, excerpt } = req.body;
    const validation = validateBlog(title, body, tags ? tags.split(",") : []);
    if (!validation.isValid) return res.render("addBlog", { user: req.user, error: validation.errors.join(", ") });

    const tagsArray = tags ? tags.split(",").map(t => t.trim()).filter(t => t).slice(0, 10) : [];
    const newBlog = await Blog.create({
      title: String(title).trim().substring(0, 200),
      body: String(body).trim().substring(0, 50000),
      coverImageURL: req.file ? req.file.path : null,
      tags: tagsArray,
      category: String(category || "General").trim().substring(0, 100),
      status: ["published", "draft"].includes(status) ? status : "published",
      metaDescription: String(metaDescription || "").trim().substring(0, 500),
      excerpt: String(excerpt || "").trim().substring(0, 1000),
      createdBy: req.user._id
    });
    await require("../models/BlogAnalytics").create({ blog: newBlog._id, author: req.user._id });
    res.redirect(`/blogs/${newBlog._id}`);
  } catch (error) { console.error("Blog Creation Error:", error); res.render("addBlog", { user: req.user, error: "Something went wrong while creating the blog." }); }
});

router.get("/:id/edit", async (req, res) => {
  try {
    const { id } = req.params;
    if (!validateObjectId(id)) return res.status(400).send("Invalid blog ID");
    const blog = await Blog.findById(id).notDeleted().lean();
    if (!blog) return res.status(404).send("Blog not found");
    if (blog.createdBy.toString() !== req.user._id.toString()) return res.status(403).send("You are not authorized to edit this blog");
    res.render("editBlog", { user: req.user, blog, error: null });
  } catch (error) { console.error("Edit Blog Page Error:", error); res.status(500).send("Internal Server Error"); }
});

router.put("/:id", cloudinaryUpload.single("coverImage"), async (req, res) => {
  try {
    const { id } = req.params;
    if (!validateObjectId(id)) return res.status(400).json({ success: false, message: "Invalid blog ID" });
    const { title, body, tags, category, status, metaDescription, excerpt } = req.body;
    const blog = await Blog.findById(id);
    if (!blog) return res.status(404).json({ success: false, message: "Blog not found" });
    if (blog.createdBy.toString() !== req.user._id.toString()) return res.status(403).json({ success: false, message: "Not authorized" });

    const validation = validateBlog(title, body, tags ? tags.split(",") : []);
    if (!validation.isValid) return res.status(400).json({ success: false, errors: validation.errors });

    blog.title = String(title).trim().substring(0, 200);
    blog.body = String(body).trim().substring(0, 50000);
    blog.tags = tags ? tags.split(",").map(t => t.trim()).filter(t => t).slice(0, 10) : [];
    blog.category = String(category || "General").trim().substring(0, 100);
    blog.status = ["published", "draft"].includes(status) ? status : "published";
    blog.metaDescription = String(metaDescription || "").trim().substring(0, 500);
    blog.excerpt = String(excerpt || "").trim().substring(0, 1000);
    if (req.file) blog.coverImageURL = req.file.path;

    await blog.save();
    await redis.invalidateBlogCache(id);
    const updatedBlog = await Blog.findById(id).populate("createdBy", "fullName profileImageURL bio followers").lean();
    await redis.cacheBlog(id, updatedBlog, 300);
    res.json({ success: true, blog: updatedBlog });
  } catch (error) { console.error("Update Blog Error:", error); res.status(500).json({ success: false, message: "Failed to update blog" }); }
});

router.delete("/:id", async (req, res) => {
  try {
    const { id } = req.params;
    if (!validateObjectId(id)) return res.status(400).json({ success: false, message: "Invalid blog ID" });
    const blog = await Blog.findById(id);
    if (!blog) return res.status(404).json({ success: false, message: "Blog not found" });
    if (blog.createdBy.toString() !== req.user._id.toString()) return res.status(403).json({ success: false, message: "Not authorized" });
    blog.isDeleted = true;
    blog.deletedAt = new Date();
    await blog.save();
    await redis.invalidateBlogCache(id);
    res.json({ success: true, message: "Blog deleted successfully" });
  } catch (error) { console.error("Delete Blog Error:", error); res.status(500).json({ success: false, message: "Failed to delete blog" }); }
});

router.post("/:id/like", likeLimiter, async (req, res) => {
  try {
    const { id } = req.params;
    if (!validateObjectId(id)) return res.status(400).json({ success: false, message: "Invalid blog ID" });
    const blog = await Blog.findById(id);
    if (!blog) return res.status(404).json({ success: false, message: "Blog not found" });
    const hasLiked = blog.likes.some(lid => lid.toString() === req.user._id.toString());
    if (hasLiked) {
      blog.likes = blog.likes.filter(lid => lid.toString() !== req.user._id.toString());
    } else {
      blog.likes.push(req.user._id);
      if (blog.createdBy.toString() !== req.user._id.toString()) {
        await NotificationService.createNotification(blog.createdBy, "like", {
          title: "New like", message: `${req.user.fullName} liked your blog`, blog: blog._id, actor: req.user._id
        });
      }
    }
    await blog.save();
    await redis.invalidateBlogCache(id);
    res.json({ success: true, liked: !hasLiked, likeCount: blog.likes.length });
  } catch (error) { console.error("Like Blog Error:", error); res.status(500).json({ success: false, message: "Failed to like blog" }); }
});

module.exports = router;
