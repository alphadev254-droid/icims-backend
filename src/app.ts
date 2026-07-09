import 'dotenv/config';
import path from 'path';
import express from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import authRoutes from './routes/auth';
import memberRoutes from './routes/members';
import eventRoutes from './routes/events';
import givingRoutes from './routes/giving';
import dashboardRoutes from './routes/dashboard';
import rolesRoutes from './routes/roles';
import attendanceRoutes from './routes/attendance';
import announcementRoutes from './routes/announcements';
import churchRoutes from './routes/churches';
import resourceRoutes from './routes/resources';
import userRoutes from './routes/users';
import locationRoutes from './routes/locations';
import packageRoutes from './routes/packages';
import transactionRoutes from './routes/transactions';
import paymentRoutes from './routes/payments';
import paymentStatusRoutes from './routes/paymentStatus';
import subaccountRoutes from './routes/subaccounts';
import uploadRoutes from './routes/upload';
import passwordResetRoutes from './routes/passwordReset';
import webhookRoutes from './routes/webhookRoutes';
import walletRoutes from './routes/walletRoutes';
import kpiRoutes from './routes/kpiRoutes';
import teamRoutes from './routes/teams';
import teamCommunicationRoutes from './routes/teamCommunication';
import reminderRoutes from './routes/reminderRoutes';
import adminRoutes from './routes/adminRoutes';
import cellRoutes from './routes/cells';
import contactRoutes from './routes/contact';
import churchProfileRoutes from './routes/churchProfile';
import pushRoutes from './routes/pushRoutes';
import childrenRoutes from './routes/children';
import { sharedAccessProtectedRoutes, sharedAccessPublicRoutes } from './routes/sharedAccessRoutes';
import { errorHandler } from './middleware/errorHandler';

declare global {
  namespace Express {
    interface Request {
      rawBody?: Buffer;
    }
  }
}

const app = express();

// ─── CORS — allow frontend origin with credentials ─────────────────────────
app.use(cors({
  origin: (origin, callback) => {
    if (!origin) return callback(null, true); // server-to-server / curl
    const allowed = [
      'https://churchcentral.church',
      'https://www.churchcentral.church',
      process.env.FRONTEND_URL || 'http://localhost:8080',
      'http://localhost:5173',
    ];
    // Allow any subdomain of churchcentral.church
    if (origin.endsWith('.churchcentral.church')) return callback(null, true);
    if (allowed.includes(origin)) return callback(null, true);
    callback(new Error('Not allowed by CORS'));
  },
  credentials: true,
}));


app.use('/api/webhooks/paychangu', (req, res, next) => {
  // Only apply raw body parsing to POST requests (webhook), not GET (callback)
  if (req.method !== 'POST') return next();
  express.raw({ type: 'application/json' })(req, res, (err) => {
    if (err) return next(err);
    if (Buffer.isBuffer(req.body) && req.body.length > 0) {
      req.rawBody = req.body;
      try {
        req.body = JSON.parse(req.body.toString());
      } catch (e) {
        return next(e);
      }
    }
    next();
  });
});

// ─── Raw body capture for webhook signature verification ──────────────────
app.use('/api/webhooks/paystack', express.raw({ type: 'application/json' }), (req, _res, next) => {
  req.rawBody = req.body as Buffer;
  req.body = JSON.parse(req.body.toString());
  next();
});

// ─── Body parsing & cookies ────────────────────────────────────────────────
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

// ─── Serve uploaded files ──────────────────────────────────────────────────
app.use('/uploads', express.static(path.join(process.cwd(), 'uploads')));

// ─── Health check ──────────────────────────────────────────────────────────
app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// ─── Routes ────────────────────────────────────────────────────────────────
app.use('/api/auth', authRoutes);
app.use('/api/password-reset', passwordResetRoutes);
// app.use('/api/members', memberRoutes); // Deprecated - use /api/users instead
app.use('/api/events', eventRoutes);
app.use('/api/giving', givingRoutes);
app.use('/api/dashboard', dashboardRoutes);
app.use('/api/roles', rolesRoutes);
app.use('/api/attendance', attendanceRoutes);
app.use('/api/announcements', announcementRoutes);
app.use('/api/churches', churchRoutes);
app.use('/api/resources', resourceRoutes);
app.use('/api/users', userRoutes);
app.use('/api/locations', locationRoutes);
app.use('/api/packages', packageRoutes);
app.use('/api/transactions', transactionRoutes);
app.use('/api/payments', paymentRoutes);
app.use('/api/payment-status', paymentStatusRoutes);
app.use('/api/subaccounts', subaccountRoutes);
app.use('/api/upload', uploadRoutes);
app.use('/api/webhooks', webhookRoutes);
app.use('/api/wallet', walletRoutes);
app.use('/api/kpis', kpiRoutes);
app.use('/api/teams', teamRoutes);
app.use('/api/team-communications', teamCommunicationRoutes);
app.use('/api/reminders', reminderRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/cells', cellRoutes);
app.use('/api/contact', contactRoutes);
app.use('/api', churchProfileRoutes);  // mounts /api/church-profile and /api/p/:slug
app.use('/api/push', pushRoutes);
app.use('/api/children', childrenRoutes);
app.use('/api/shared-access', sharedAccessProtectedRoutes);
app.use('/api/public/shared-access', sharedAccessPublicRoutes);

// ─── 404 ──────────────────────────────────────────────────────────────────
app.use((_req, res) => {
  res.status(404).json({ success: false, message: 'Route not found' });
});

// ─── Global error handler ─────────────────────────────────────────────────
app.use(errorHandler);

export default app;
