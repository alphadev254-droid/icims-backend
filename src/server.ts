import app from './app';
import prisma from './lib/prisma';

const PORT = process.env.PORT || 5000;

async function main() {
  // Verify DB connection
  await prisma.$connect();
  console.log('✅ Database connected');

  app.listen(PORT, () => {
    console.log(`🚀 ICIMS API running on http://localhost:${PORT}`);
    console.log(`   Health: http://localhost:${PORT}/api/health`);
    console.log(`   Auth:   http://localhost:${PORT}/api/auth`);
    console.log(`   Env:    ${process.env.NODE_ENV}`);
  });
}

main().catch(err => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
