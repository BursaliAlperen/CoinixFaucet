const { body, param, query, validationResult } = require('express-validator');

const handleValidationErrors = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ error: 'Validation failed', details: errors.array() });
  }
  next();
};

const userIdParam = [param('userId').trim().isLength({ min: 1, max: 50 }).escape(), handleValidationErrors];
const claimBody = [body('user_id').trim().isLength({ min: 1, max: 50 }).escape(), handleValidationErrors];
const withdrawBody = [
  body('user_id').trim().isLength({ min: 1, max: 50 }).escape(),
  body('amount').isFloat({ min: 0.01 }),
  body('address').trim().isLength({ min: 3, max: 255 }).escape(),
  body('currency').isIn(['cnx', 'doge']),
  handleValidationErrors
];
const swapBody = [
  body('user_id').trim().isLength({ min: 1, max: 50 }).escape(),
  body('from_currency').isIn(['cnx', 'doge']),
  body('to_currency').isIn(['cnx', 'doge']),
  body('amount').isFloat({ min: 0.01 }),
  handleValidationErrors
];
const adminAction = [
  body('id').optional().trim().escape(),
  body('user_id').optional().trim().escape(),
  handleValidationErrors
];

module.exports = { handleValidationErrors, userIdParam, claimBody, withdrawBody, swapBody, adminAction };
