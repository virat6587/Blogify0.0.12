const path = require("path");
const express = require("express");
const mongoose = require("mongoose");
const cookieParser = require("cookie-parser");
const passport = require("passport");
const { createHandler } = require("graphql-http/lib/use/express");
const helmet = require("helmet");
const mongoSanitize = require("express-mongo-sanitize");
const hpp = require("hpp");
const cors = require("cors");

const { Marked } = require("marked");
const { markedHighlight } = require("marked-highlight");
const hljs = require("highlight.js");

const RedisClient = require("./config/redis");
const commentWorker = require("./workers/commentWorker");

process.on("warning", (warning) => {
  if (warning.code === "MONGOOSE" && warning.message.includes("Duplicate schema index")) return;
  console.warn(warning);
});

const UserRoute = require("./routes/User");
const GoogleAuthRoute = require("./routes/GoogleAuthentication");
const BlogRoute = require("./routes/Blog");
const AdminRoute = require("./routes/Admin");
const ProfileRoute = require("./routes/Profile");
const CommentRoute = require("./routes/Comment");
const FollowRoute = require("./routes/Follow");
const NotificationRoute = require("./routes/Notification");
const AnalyticsRoute = require("./routes/Analytics");

const { checkForAuthenticationCookie } = require("./middlewares/authentication");
const { queryHandler } = require("./middlewares/queryParams");
const { apiLimiter } = require("./middlewares/rateLimiting");
const { schema, root } = require("./graphql/schema");

const app = express();
const PORT = process.env.PORT || 8000;

require("dotenv").config();

const marked = new Marked(
  markedHighlight({
    emptyLangClass: "hljs",
    langPrefix: "hljs language-",
    highlight(code, lang) {
      const language = hljs.getLanguage(lang) ? lang : "plaintext";
      return hljs.highlight(code, { language }).value;
    }
  })
);

const redis = RedisClient.getInstance();
redis.connect()
  .then(() => {
    console.log("[App] Redis ready");
    commentWorker.start();
  })
  .catch(err => {
    console.error("[App] Redis failed - running in degraded mode:", err.message);
  });

mongoose.connect(process.env.MONGODB_URI || "mongodb://localhost:27017/blogify", {
  maxPoolSize: 50,
  serverSelectionTimeoutMS: 5000,
  socketTimeoutMS: 45000,
})
  .then(() => console.log("MongoDB Connected"))
  .catch(err => {
    console.error("MongoDB Connection Error:", err.message);
    process.exit(1);
  });

app.set("view engine", "ejs");
app.set("views", path.resolve("./views"));

app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'", "https:"],
      scriptSrc: ["'self'"],
      imgSrc: ["'self'", "https:", "data:", "blob:"],
      fontSrc: ["'self'", "https:"],
      connectSrc: ["'self'"],
      frameAncestors: ["'none'"],
      upgradeInsecureRequests: [],
    },
  },
  crossOriginEmbedderPolicy: false,
  hsts: { maxAge: 31536000, includeSubDomains: true, preload: true }
}));

app.use(cors({
  origin: process.env.ALLOWED_ORIGINS?.split(",") || ["http://localhost:8000"],
  credentials: true,
  methods: ["GET", "POST", "PUT", "DELETE", "PATCH"],
  allowedHeaders: ["Content-Type", "Authorization"]
}));

app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true, limit: "10mb" }));
app.use(cookieParser());
app.use(mongoSanitize({ replaceWith: "_", onSanitize: ({ req, key }) => console.warn(`[Sanitize] Sanitized key: ${key} from ${req.url}`) }));
app.use(hpp());
app.use(express.static(path.resolve("./public")));

app.use(passport.initialize());
app.use(checkForAuthenticationCookie("token"));
app.use(queryHandler);
app.use("/api/", apiLimiter);

app.locals.truncate = function(text, length = 60) {
  if (!text) return "";
  text = String(text);
  if (text.length <= length) return text;
  return text.substring(0, length).trim() + "...";
};

app.locals.formatDate = function(date) {
  if (!date) return "";
  return new Date(date).toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" });
};

app.locals.renderMarkdown = function(rawContent) {
  if (!rawContent) return "";
  let contentString = String(rawContent);
  const codeBlocks = [];
  contentString = contentString.replace(/```([\s\S]*?)```/g, (match) => {
    codeBlocks.push(match);
    return `__BLOGIFY_CODE_BLOCK_PLACEHOLDER_${codeBlocks.length - 1}__`;
  });
  contentString = contentString
    .replace(/\\ppbr\\pp/g, "\n\n")
    .replace(/\\ppbr\\ph2/g, "\n\n## ")
    .replace(/\\ppbr\\ph/g, "\n\n# ")
    .replace(/\\pp/g, "\n")
    .replace(/\\h2pbr\\pp/g, "\n## ")
    .replace(/\\strongpbr\\ph2/g, "\n\n## ")
    .replace(/\\li\\ul/g, "")
    .replace(/\\li/g, "\n* ")
    .replace(/pbr\\pul/g, "\n\n")
    .replace(/pbr\\p/g, "\n")
    .replace(/<<\\strong>/g, "**")
    .replace(/< \*\*/g, "**");
  contentString = contentString.replace(/__BLOGIFY_CODE_BLOCK_PLACEHOLDER_(\d+)__/g, (match, index) => codeBlocks[parseInt(index)]);
  return marked.parse(contentString);
};

app.all("/graphql", createHandler({
  schema: schema,
  rootValue: root,
  context: (req) => ({ user: req.raw.user })
}));

app.get("/health", async (req, res) => {
  const redisStatus = redis.isConnected ? "connected" : "disconnected";
  const queueDepth = redis.isConnected ? await redis.client.lLen(redis.keys.COMMENT_QUEUE) : "N/A";
  res.json({ status: "ok", redis: redisStatus, queueDepth, worker: commentWorker.getStats(), mongodb: mongoose.connection.readyState === 1 ? "connected" : "disconnected" });
});

app.get("/", async (req, res) => {
  try {
    const Blog = require("./models/Blog");
    const queryParams = req.queryParams || req.query || {};
    const { search = "", sort = "newest", page = 1, limit = 9 } = queryParams;
    const filter = { isDeleted: false, status: "published" };
    if (search) filter.$or = [{ title: { $regex: search, $options: "i" } }, { body: { $regex: search, $options: "i" } }];
    let sortOption = { createdAt: -1 };
    if (sort === "oldest") sortOption = { createdAt: 1 };
    if (sort === "title") sortOption = { title: 1 };
    if (sort === "trending") sortOption = { viewCount: -1 };
    const skip = (parseInt(page) - 1) * parseInt(limit);
    const blogs = await Blog.find(filter).sort(sortOption).skip(skip).limit(parseInt(limit)).populate("createdBy", "fullName profileImageURL").lean();
    const totalBlogs = await Blog.countDocuments(filter);
    const totalPages = Math.ceil(totalBlogs / limit);
    const featuredBlogs = await Blog.find({ isFeatured: true, status: "published", isDeleted: false }).sort({ featuredRank: 1 }).limit(3).populate("createdBy", "fullName profileImageURL").lean();
    res.render("home", { title: "Blogify", user: req.user || null, blogs: blogs || [], featuredBlogs, currentPage: parseInt(page), totalPages, totalBlogs, search, sort });
  } catch (error) {
    console.error("Home Route Error:", error.message);
    res.status(500).send("Internal Server Error");
  }
});

app.use("/admin", AdminRoute);
app.use("/user/profile", ProfileRoute);
app.use("/user", UserRoute);
app.use("/user", GoogleAuthRoute);
app.use("/blogs", BlogRoute);
app.use("/comments", CommentRoute);
app.use("/follow", FollowRoute);
app.use("/notifications", NotificationRoute);
app.use("/analytics", AnalyticsRoute);

app.use((req, res) => { res.status(404).render("404"); });

app.use((err, req, res, next) => {
  console.error("Server Error:", err);
  res.status(500).send("Internal Server Error");
});

process.on("SIGTERM", async () => {
  console.log("[App] SIGTERM received - shutting down gracefully");
  commentWorker.stop();
  await redis.disconnect();
  await mongoose.disconnect();
  process.exit(0);
});

process.on("SIGINT", async () => {
  console.log("[App] SIGINT received - shutting down gracefully");
  commentWorker.stop();
  await redis.disconnect();
  await mongoose.disconnect();
  process.exit(0);
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`Visit http://localhost:${PORT}`);
});

module.exports = app;
