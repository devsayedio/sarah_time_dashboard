const path = require('path');
const { initializeApp, cert } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');

const serviceAccount = require(path.join(__dirname, '..', 'service-account.json'));
const shouldApply = process.argv.includes('--apply');

initializeApp({
  credential: cert(serviceAccount),
  projectId: 'employee-attendance-30f81'
});

const db = getFirestore();
const profileStringFields = [
  'employeeName',
  'employeeId',
  'profileImagePath',
  'designation',
  'department',
  'employmentType',
  'officialEmail',
  'phoneNumber',
  'personalEmail',
  'presentAddress',
  'emergencyContactName',
  'emergencyContactNumber',
  'emergencyContactRelationship',
  'permanentAddress',
  'nidOrPassport',
  'bankAccount',
  'salary'
];

function validateProfile(employeeId, profile) {
  for (const field of profileStringFields) {
    if (typeof profile[field] !== 'string') {
      throw new Error(`Invalid profile field ${field} for employee ${employeeId}`);
    }
  }
  if (!profile.joiningDate || typeof profile.joiningDate.toDate !== 'function') {
    throw new Error(`Invalid joiningDate for employee ${employeeId}`);
  }
}

function validateAttendance(employeeId, dateKey, attendance) {
  if (attendance.schemaVersion !== 1 ||
      !attendance.checkInAt ||
      typeof attendance.checkInAt.toDate !== 'function' ||
      (attendance.status !== 'present' && attendance.status !== 'late')) {
    throw new Error(`Invalid attendance ${dateKey} for employee ${employeeId}`);
  }
}

async function migrate() {
  const employeesSnapshot = await db.collection('employees').get();
  const writer = shouldApply ? db.bulkWriter() : null;
  let profileDocuments = 0;
  let attendanceDocuments = 0;

  for (const employeeDocument of employeesSnapshot.docs) {
    const profileDocument = await employeeDocument.ref
      .collection('profile')
      .doc('details')
      .get();

    if (!profileDocument.exists) {
      throw new Error(`Missing profile for employee ${employeeDocument.id}`);
    }

    validateProfile(employeeDocument.id, profileDocument.data());
    profileDocuments++;
    if (writer) {
      writer.set(
        employeeDocument.ref,
        { ...profileDocument.data(), ...employeeDocument.data() },
        { merge: false }
      );
    }

    const attendanceSnapshot = await employeeDocument.ref
      .collection('attendance_history')
      .get();

    for (const attendanceDocument of attendanceSnapshot.docs) {
      validateAttendance(
        employeeDocument.id,
        attendanceDocument.id,
        attendanceDocument.data()
      );
      attendanceDocuments++;
      if (writer) {
        writer.set(
          db.collection('attendance').doc(`${attendanceDocument.id}_${employeeDocument.id}`),
          {
            ...attendanceDocument.data(),
            employeeId: employeeDocument.id,
            dateKey: attendanceDocument.id
          },
          { merge: false }
        );
      }
    }
  }

  if (writer) await writer.close();

  console.log(JSON.stringify({
    mode: shouldApply ? 'applied' : 'dry-run',
    employees: employeesSnapshot.size,
    profileDocuments,
    attendanceDocuments
  }, null, 2));

  if (!shouldApply) {
    console.log('No writes were made. Run again with --apply after deploying indexes.');
  }
}

migrate().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
