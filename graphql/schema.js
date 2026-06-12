const { buildSchema } = require("graphql");
const Blog = require("../models/Blog");
const User = require("../models/user");

const schema = buildSchema(`
  type User {
    _id: ID
    fullName: String
    email: String
    profileImageURL: String
    role: String
  }

  type Blog {
    _id: ID
    title: String
    body: String
    coverImageURL: String
    createdAt: String
    createdBy: User
  }

  type Query {
    blogs(search: String, sort: String, page: Int = 1, limit: Int = 9): [Blog]
    blog(id: ID!): Blog
    me: User
  }
`);

const root = {
  blogs: async ({ search, sort = "newest", page = 1, limit = 9 }) => {
    try {
      const filter = search ? {
        $or: [
          { title: { $regex: search, $options: "i" } },
          { body: { $regex: search, $options: "i" } }
        ]
      } : {};
      let sortOption = { createdAt: -1 };
      if (sort === "oldest") sortOption = { createdAt: 1 };
      if (sort === "title") sortOption = { title: 1 };
      return await Blog.find(filter).sort(sortOption).skip((page - 1) * limit).limit(limit).populate("createdBy", "fullName profileImageURL").lean();
    } catch (error) { console.error("GraphQL blogs error:", error); return []; }
  },

  blog: async ({ id }) => {
    try {
      return await Blog.findById(id).populate("createdBy", "fullName profileImageURL").lean();
    } catch (error) { console.error("GraphQL blog error:", error); return null; }
  },

  me: (args, context) => context.user || null
};

module.exports = { schema, root };
