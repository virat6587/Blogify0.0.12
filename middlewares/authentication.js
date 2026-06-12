const { verifyToken } = require("../services/authentication");

const checkForAuthenticationCookie = (cookieName) => {
  return (req, res, next) => {
    const token = req.cookies[cookieName];
    req.user = null;
    if (!token) return next();
    try { req.user = verifyToken(token); } catch (e) {}
    next();
  };
};

const restrictToLoggedInUserOnly = (req, res, next) => {
  if (!req.user) return res.redirect("/user/signin");
  next();
};

const restrictTo = (roles = []) => {
  return (req, res, next) => {
    if (!req.user) return res.redirect("/user/signin");
    if (!roles.includes(req.user.role)) return res.status(403).send("Access Denied: Admins Only");
    next();
  };
};

module.exports = {
  checkForAuthenticationCookie,
  restrictTo,
  restrictToLoggedInUserOnly
};
