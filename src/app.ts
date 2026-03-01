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
import { errorHandler } from './middleware/errorHandler';

const app = express();

// ─── CORS — allow frontend origin with credentials ─────────────────────────
app.use(cors({
  origin: process.env.FRONTEND_URL || 'http://localhost:8080',
  credentials: true,   // needed for cookies
}));

// ─── Body parsing & cookies ────────────────────────────────────────────────
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

// ─── Health check ──────────────────────────────────────────────────────────
app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// ─── Routes ────────────────────────────────────────────────────────────────
app.use('/api/auth', authRoutes);
app.use('/api/members', memberRoutes);
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

// ─── Serve uploaded files ──────────────────────────────────────────────────
app.use('/uploads', express.static(path.join(process.cwd(), 'uploads')));

// ─── 404 ──────────────────────────────────────────────────────────────────
app.use((_req, res) => {
  res.status(404).json({ success: false, message: 'Route not found' });
});

// ─── Global error handler ─────────────────────────────────────────────────
app.use(errorHandler);

export default app;
