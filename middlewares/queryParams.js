const queryHandler = (req, res, next) => {
  req.queryParams = req.query || {};
  next();
};

module.exports = { queryHandler };
