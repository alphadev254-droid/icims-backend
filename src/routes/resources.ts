import { Router } from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { authenticate, authorizePermission } from '../middleware/auth';
import { getResources, createResource, updateResource, deleteResource } from '../controllers/resourceController';

const router = Router();
router.use(authenticate);

// Ensure uploads directory exists
const uploadsDir = path.join(process.cwd(), 'uploads');
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, uploadsDir),
  filename: (_req, file, cb) => {
    const unique = `${Date.now()}-${Math.round(Math.random() * 1e9)}`;
    cb(null, `${unique}${path.extname(file.originalname)}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 200 * 1024 * 1024 }, // 200 MB per file
  fileFilter: (_req, file, cb) => {
    const allowed = [
      // Documents
      'application/pdf',
      'application/msword',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'application/vnd.ms-powerpoint',
      'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      'text/plain',
      // Images
      'image/jpeg', 'image/png', 'image/gif', 'image/webp',
      // Audio
      'audio/mpeg', 'audio/wav', 'audio/mp4', 'audio/x-m4a', 'audio/aac', 'audio/ogg',
      // Video
      'video/mp4', 'video/webm', 'video/quicktime', 'video/x-msvideo', 'video/mpeg',
    ];
    if (allowed.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error(`File type not allowed: ${file.mimetype}`));
    }
  },
});

router.get('/',       authorizePermission('resources:read'),   getResources);
router.post('/',      authorizePermission('resources:create'), upload.array('files', 10), createResource);
router.put('/:id',    authorizePermission('resources:create'), upload.array('files', 10), updateResource);
router.delete('/:id', authorizePermission('resources:create'), deleteResource);

export default router;
