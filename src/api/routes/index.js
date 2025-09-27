const express = require('express');
const printerRoutes = require('./printerRoutes');

const router = express.Router();

router.use(printerRoutes);

module.exports = router;