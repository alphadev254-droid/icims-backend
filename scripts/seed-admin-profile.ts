/**
 * seed-admin-profile.ts
 *
 * Creates a subdomain + full church profile for admin@icims.org.
 * Run with:  npm run seed:admin-profile
 *
 * What it does:
 *  1. Finds the admin user
 *  2. Creates the DNS subdomain via Hostinger (if not already set)
 *  3. Upserts a fully-populated ChurchProfile (all text fields filled,
 *     image fields left null — upload via the dashboard)
 *  4. Marks the profile as published
 */

import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { createSubdomain, toSlug } from '../src/lib/hostingerDns';

const prisma = new PrismaClient();

const ADMIN_EMAIL = 'admin@icims.org';

async function main() {
  console.log('🌱 Seeding admin church profile...\n');

  // ── 1. Find admin user ────────────────────────────────────────────────────
  const user = await prisma.user.findUnique({
    where: { email: ADMIN_EMAIL },
    select: { id: true, ministryName: true, subdomain: true, firstName: true, lastName: true },
  });

  if (!user) {
    console.error(`❌ User ${ADMIN_EMAIL} not found. Run db:seed first.`);
    process.exit(1);
  }

  console.log(`✅ Found user: ${user.firstName} ${user.lastName} (${ADMIN_EMAIL})`);

  // ── 2. Create subdomain if not already set ────────────────────────────────
  let subdomain = user.subdomain;

  if (!subdomain) {
    const slugSource = user.ministryName || `${user.firstName} ${user.lastName}`;
    const slug = toSlug(slugSource);
    console.log(`\n🌐 Creating subdomain for slug: "${slug}"...`);

    const fullSubdomain = await createSubdomain(slug);
    if (fullSubdomain) {
      await prisma.user.update({
        where: { id: user.id },
        data: { subdomain: fullSubdomain },
      });
      subdomain = fullSubdomain;
      console.log(`✅ Subdomain created: ${fullSubdomain}`);
    } else {
      console.warn('⚠️  Subdomain creation failed — continuing without it.');
    }
  } else {
    console.log(`✅ Subdomain already set: ${subdomain}`);
  }

  // ── 3. Upsert church profile ──────────────────────────────────────────────
  console.log('\n📝 Upserting church profile...');

  const profile = await prisma.churchProfile.upsert({
    where: { ministryAdminId: user.id },
    update: {
      // Branding
      primaryColor:  '#d4a574',
      tagline:       'A place of hope, community, and faith.',

      // About
      aboutText: `Welcome to ICIMS Church — a vibrant, Spirit-filled community committed to worship, discipleship, and service. We believe every person has a God-given purpose, and we exist to help you discover and live it out.

Whether you are new to faith or have walked with God for years, there is a place for you here. Join us as we grow together in love and truth.`,

      visionText:  'To see every person transformed by the love of Christ and empowered to impact their community.',
      missionText: 'Making disciples who make disciples — through worship, the Word, and authentic community.',

      pastorName: 'Pastor James Banda',
      pastorBio:  'Pastor James has served in ministry for over 15 years, with a passion for teaching the Word and building strong families. He holds a degree in Theology and is married with three children.',

      // Service times — JSON array
      serviceTimes: JSON.stringify([
        { name: 'Sunday Service',       day: 'Sunday',    time: '9:00 AM',  location: 'Main Auditorium' },
        { name: 'Sunday Second Service', day: 'Sunday',   time: '11:30 AM', location: 'Main Auditorium' },
        { name: 'Wednesday Bible Study', day: 'Wednesday', time: '6:30 PM', location: 'Fellowship Hall' },
        { name: 'Friday Youth Service',  day: 'Friday',    time: '5:00 PM', location: 'Youth Centre' },
      ]),

      // Contact
      phone:          '+254 720 874 025',
      email:          'info@icims.church',
      address:        'Nairobi, Kenya',
      facebookUrl:    'https://facebook.com/icimskenya',
      youtubeUrl:     'https://youtube.com/@icimskenya',
      whatsappNumber: '254720874025',

      // Publish
      isPublished: true,
    },
    create: {
      ministryAdminId: user.id,

      primaryColor:  '#d4a574',
      tagline:       'A place of hope, community, and faith.',

      aboutText: `Welcome to ICIMS Church — a vibrant, Spirit-filled community committed to worship, discipleship, and service. We believe every person has a God-given purpose, and we exist to help you discover and live it out.

Whether you are new to faith or have walked with God for years, there is a place for you here. Join us as we grow together in love and truth.`,

      visionText:  'To see every person transformed by the love of Christ and empowered to impact their community.',
      missionText: 'Making disciples who make disciples — through worship, the Word, and authentic community.',

      pastorName: 'Pastor James Banda',
      pastorBio:  'Pastor James has served in ministry for over 15 years, with a passion for teaching the Word and building strong families. He holds a degree in Theology and is married with three children.',

      serviceTimes: JSON.stringify([
        { name: 'Sunday Service',        day: 'Sunday',    time: '9:00 AM',  location: 'Main Auditorium' },
        { name: 'Sunday Second Service', day: 'Sunday',    time: '11:30 AM', location: 'Main Auditorium' },
        { name: 'Wednesday Bible Study', day: 'Wednesday', time: '6:30 PM',  location: 'Fellowship Hall' },
        { name: 'Friday Youth Service',  day: 'Friday',    time: '5:00 PM',  location: 'Youth Centre' },
      ]),

      phone:          '+254 720 874 025',
      email:          'info@icims.church',
      address:        'Nairobi, Kenya',
      facebookUrl:    'https://facebook.com/icimskenya',
      youtubeUrl:     'https://youtube.com/@icimskenya',
      whatsappNumber: '254720874025',

      isPublished: true,
    },
  });

  console.log('✅ Church profile saved\n');

  // ── 4. Summary ────────────────────────────────────────────────────────────
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('🎉 Done!\n');
  console.log(`  Admin email:  ${ADMIN_EMAIL}`);
  console.log(`  Subdomain:    ${subdomain ?? '(not set)'}`);
  if (subdomain) {
    const url = subdomain.includes('.') ? `https://${subdomain}` : `https://${subdomain}.churchcentral.church`;
    console.log(`  Public URL:   ${url}`);
  }
  console.log(`  Published:    ${profile.isPublished ? 'Yes ✅' : 'No (draft)'}`);
  console.log('\n  ⚠️  Upload logo, banner, and pastor photo via the dashboard:');
  console.log('     /dashboard/church-profile → Branding section');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
}

main()
  .catch(e => { console.error('❌ Error:', e); process.exit(1); })
  .finally(() => prisma.$disconnect());
