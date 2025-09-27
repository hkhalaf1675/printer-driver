const createError = require('http-errors');

const validator = (schema) => (req, res, next) => {
  const { error, value } = schema.validate(req.body);

  if (error) {
    // Create a user-friendly error message
    const errorMessage = `Validation error: ${error.details.map((detail) => detail.message).join(', ')}`;
    return next(createError(400, errorMessage));
  }
  
  req.body = value; // Replace body with validated and defaulted values
  return next();
};

module.exports = validator;