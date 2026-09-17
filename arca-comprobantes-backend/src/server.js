require('dotenv').config();
const express = require('express');
const cors = require('cors');
const comprobantesRoutes = require('./routes/comprobantes.routes');
const rendicionesRoutes = require('./routes/rendiciones.routes');
const { requireAuth } = require('./middleware/auth');

const app = express();
app.use(cors());
app.use(express.json());

app.get('/api/health', (req, res) => res.json({ ok: true }));
app.use('/api/comprobantes', requireAuth, comprobantesRoutes);
app.use('/api/rendiciones', requireAuth, rendicionesRoutes);

const PORT = process.env.PORT || 4010;
app.listen(PORT, () => console.log(`arca-comprobantes-backend escuchando en puerto ${PORT}`));
