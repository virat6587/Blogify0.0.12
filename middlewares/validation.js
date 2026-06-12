const validateEmail = (email) => {
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return emailRegex.test(email);
};

const validatePassword = (password) => password.length >= 6;

const sanitizeInput = (input) => {
  if (typeof input !== "string") return input;
  return input.trim().substring(0, 5000);
};

const sanitizeHtml = (input) => {
  if (typeof input !== "string") return input;
  return input
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#x27;")
    .trim()
    .substring(0, 5000);
};

const validateBlog = (title, body, tags = []) => {
  const errors = [];
  if (!title || title.trim().length === 0) errors.push("Title is required");
  if (title && title.length > 200) errors.push("Title must be less than 200 characters");
  if (!body || body.trim().length === 0) errors.push("Content is required");
  if (body && body.length > 50000) errors.push("Content is too long (max 50000 characters)");
  if (tags.length > 10) errors.push("Maximum 10 tags allowed");
  tags.forEach(tag => { if (tag.length > 50) errors.push(`Tag "${tag}" exceeds 50 characters`); });
  return { isValid: errors.length === 0, errors };
};

const validateComment = (content) => {
  const errors = [];
  if (!content || content.trim().length === 0) errors.push("Comment cannot be empty");
  if (content && content.length > 5000) errors.push("Comment is too long (max 5000 characters)");
  return { isValid: errors.length === 0, errors };
};

const validateObjectId = (id) => {
  const { ObjectId } = require("mongoose").Types;
  return ObjectId.isValid(id) && new ObjectId(id).toString() === id;
};

module.exports = {
  validateEmail,
  validatePassword,
  sanitizeInput,
  sanitizeHtml,
  validateBlog,
  validateComment,
  validateObjectId
};
