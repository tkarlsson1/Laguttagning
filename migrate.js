const admin = require('firebase-admin');
const serviceAccount = require('./serviceAccount.json');

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});

const db = admin.firestore();

const ADMIN_UID    = 'QLpq1rXHz2gjiipKFCnxEKk5xWx2';
const TEAM1_ID     = 'irsta-p12';
const TEAM2_ID     = 'ik-oden-p14';

async function migrate() {
  console.log('Starting migration...');

  // ── Create teams ──────────────────────────────────
  await db.collection('teams').doc(TEAM1_ID).set({
    name: 'Irsta P12',
    format: '9v9',
    createdBy: ADMIN_UID,
    createdAt: admin.firestore.FieldValue.serverTimestamp()
  });
  console.log('Created team: Irsta P12');

  await db.collection('teams').doc(TEAM2_ID).set({
    name: 'IK Oden P14',
    format: '9v9',
    createdBy: ADMIN_UID,
    createdAt: admin.firestore.FieldValue.serverTimestamp()
  });
  console.log('Created team: IK Oden P14');

  // ── Migrate collections ───────────────────────────
  const collections = ['players', 'matches', 'lineups', 'customFormations'];

  for (const col of collections) {
    const snap = await db.collection(col).get();
    if (snap.empty) {
      console.log(`No documents in ${col}, skipping.`);
      continue;
    }
    let count = 0;
    for (const docSnap of snap.docs) {
      await db.collection('teams').doc(TEAM1_ID)
        .collection(col).doc(docSnap.id)
        .set(docSnap.data());
      count++;
    }
    console.log(`Migrated ${count} documents from ${col} → teams/${TEAM1_ID}/${col}`);
  }

  // ── Set up admin record ───────────────────────────
  await db.collection('admins').doc(ADMIN_UID).set({
    email: 'admin',
    createdAt: admin.firestore.FieldValue.serverTimestamp()
  });
  console.log('Created admin record');

  // ── Set up userSettings ───────────────────────────
  await db.collection('userSettings').doc(ADMIN_UID).set({
    teams: [TEAM1_ID, TEAM2_ID],
    lastTeam: TEAM1_ID
  }, { merge: true });
  console.log('Created userSettings with both teams');

  console.log('\nMigration complete!');
  console.log('Old collections are still intact — verify the data before deleting them.');
  process.exit(0);
}

migrate().catch(err => {
  console.error('Migration failed:', err);
  process.exit(1);
});
