const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const { initializeApp, cert } = require('firebase-admin/app');
const { getMessaging } = require('firebase-admin/messaging');
const packageInfo = require('./package.json');

const isCloudflareWorker = globalThis.__SARAH_CLOUDFLARE_WORKER__ === true;
const firestoreRuntime = isCloudflareWorker
  ? require('./cloudflare/firestore-rest')
  : require('firebase-admin/firestore');
const { FieldValue, Timestamp } = firestoreRuntime;

function loadServiceAccount() {
  if (process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
    return JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
  }

  return JSON.parse(
    fs.readFileSync(path.join(__dirname, 'service-account.json'), 'utf8')
  );
}

// Local Node.js reads the gitignored file. Cloudflare receives the same JSON as
// an encrypted Worker secret and never bundles the credential into the script.
const serviceAccount = loadServiceAccount();

const firebaseApp = initializeApp({
  credential: cert(serviceAccount),
  projectId: 'employee-attendance-30f81'
});

let db;

function ensureFirebaseInitialized() {
  if (!db) {
    db = isCloudflareWorker
      ? firestoreRuntime.createFirestoreRest(firebaseApp, 'employee-attendance-30f81')
      : firestoreRuntime.getFirestore(firebaseApp);
  }
  return db;
}

if (!isCloudflareWorker) {
  ensureFirebaseInitialized();
}
const app = express();
const PORT = process.env.PORT || 3000;
const EMPLOYEES = 'employees';
const ATTENDANCE = 'attendance';

function buildInfoValue(value, fallback) {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

function readBuildInfo() {
  let generatedInfo = {};

  try {
    // Static require keeps the generated metadata inside the Cloudflare Worker
    // bundle. A runtime fs read works in local Node.js but cannot see this
    // project file after Wrangler packages the Worker.
    generatedInfo = require('./build-info.json');
  } catch (error) {
    if (error.code !== 'MODULE_NOT_FOUND') {
      console.warn(`Could not read build metadata: ${error.message}`);
    }
  }

  const commit = buildInfoValue(
    process.env.DEPLOY_COMMIT,
    buildInfoValue(generatedInfo.commit, 'unavailable')
  );

  return Object.freeze({
    version: packageInfo.version,
    buildNumber: buildInfoValue(
      process.env.BUILD_NUMBER,
      buildInfoValue(generatedInfo.buildNumber, 'development')
    ),
    commit: commit === 'unavailable' ? commit : commit.slice(0, 7),
    environment: buildInfoValue(
      process.env.DEPLOY_ENV,
      buildInfoValue(generatedInfo.environment, process.env.NODE_ENV || 'development')
    ),
    deployedAt: buildInfoValue(
      process.env.DEPLOYED_AT,
      buildInfoValue(generatedInfo.deployedAt, null)
    )
  });
}

const BUILD_INFO = readBuildInfo();

// The Flutter app parses every profile field with a strict `String` check and
// `joiningDate` as a `Timestamp`. A missing field throws a FormatException and
// breaks the whole profile/home screen, so every document must be complete.
const PROFILE_STRING_FIELDS = [
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

// The overview, attendance table, employee directory and notification picker
// only need these non-sensitive profile fields. Full HR/profile data is loaded
// from the employee-detail endpoint only when an admin opens a profile.
const DASHBOARD_PROFILE_FIELDS = [
  'employeeName',
  'employeeId',
  'designation',
  'department',
  'officialEmail'
];

// Bundled asset path in the Flutter app (SvgPath.icDemoUser).
const DEFAULT_PROFILE_IMAGE_PATH = 'assets/png/ic_demo_user.png';

function toProfileString(value) {
  return value === undefined || value === null ? '' : String(value);
}

// Firestore Timestamp -> 'YYYY-MM-DD' (Dhaka) for <input type="date">.
function toDateInputValue(timestamp) {
  if (!timestamp || typeof timestamp.toDate !== 'function') return '';
  return getDhakaDateKey(timestamp.toDate());
}

// Accepts 'YYYY-MM-DD' and stores midnight Dhaka time, matching how the app reads it.
function toJoiningTimestamp(value) {
  const { Timestamp } = require('firebase-admin/firestore');
  if (value) {
    const parsed = new Date(`${String(value).slice(0, 10)}T00:00:00+06:00`);
    if (!isNaN(parsed.getTime())) return Timestamp.fromDate(parsed);
  }
  const todayKey = getDhakaDateKey();
  return Timestamp.fromDate(new Date(`${todayKey}T00:00:00+06:00`));
}

app.use(cors());
app.use(express.json());
if (!isCloudflareWorker) {
  app.use(express.static(path.join(__dirname, 'public')));
}

// Deployment health probe. Keep it free of Firestore calls so Cloudflare and
// operational checks can verify the runtime without consuming database reads.
app.get('/healthz', (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json({ status: 'ok', uptime: process.uptime(), ...BUILD_INFO });
});

// Public release identity for the dashboard footer and operational checks.
// It intentionally exposes only non-sensitive artifact metadata.
app.get('/version', (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json(BUILD_INFO);
});

// Helper: Get Dhaka Date Key (YYYY-MM-DD)
function getDhakaDateKey(date = new Date()) {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Dhaka',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  });
  return formatter.format(date);
}

// Helper: Format Timestamp for display
function formatTimestamp(ts) {
  if (!ts) return null;
  const date = ts.toDate ? ts.toDate() : new Date(ts);
  return date.toLocaleTimeString('en-US', {
    timeZone: 'Asia/Dhaka',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: true
  });
}

// Helper: ISO weekday (Mon=1 ... Sun=7) from a YYYY-MM-DD key, timezone independent
function getIsoWeekday(dateKey) {
  const [year, month, day] = String(dateKey).split('-').map(Number);
  const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  return weekday === 0 ? 7 : weekday;
}

// Helper: Check if a date is a holiday or off-day.
// A date override always produces a notice, whether it opens or closes the office;
// only `isOfficeOpen` decides whether attendance tracking stays enabled for that date.
function getHolidayStatus(dateKey, officeSettings, dateOverrides) {
  const override = dateOverrides.find(o => o.dateKey === dateKey);

  if (override) {
    const isOfficeOpen = override.isOfficeOpen !== false;
    const reason = override.reason || (isOfficeOpen ? 'Special Working Day' : 'Closed / Holiday');

    if (isOfficeOpen) {
      return {
        isHoliday: false,
        reason: null,
        statusText: null,
        hasOverride: true,
        isOfficeOpen: true,
        notice: {
          type: 'open',
          title: 'Special Working Day (Office Open)',
          reason,
          attendanceEnabled: true
        }
      };
    }

    return {
      isHoliday: true,
      reason,
      statusText: 'holiday',
      hasOverride: true,
      isOfficeOpen: false,
      notice: {
        type: 'closed',
        title: 'Closed / Holiday',
        reason,
        attendanceEnabled: false
      }
    };
  }

  const weekday = getIsoWeekday(dateKey);
  const weeklyDays = (officeSettings && officeSettings.weeklyOfficeDays) ? officeSettings.weeklyOfficeDays : [1, 2, 3, 4, 5, 6, 7];

  if (!weeklyDays.includes(weekday)) {
    return {
      isHoliday: true,
      reason: 'Weekend / Off-Day',
      statusText: 'off-day',
      hasOverride: false,
      isOfficeOpen: false,
      notice: {
        type: 'off-day',
        title: 'Weekend / Off-Day',
        reason: 'Regular weekly off-day',
        attendanceEnabled: false
      }
    };
  }

  return {
    isHoliday: false,
    reason: null,
    statusText: null,
    hasOverride: false,
    isOfficeOpen: true,
    notice: null
  };
}

function employeeProfile(employeeData) {
  const profile = {};
  for (const field of PROFILE_STRING_FIELDS) {
    profile[field] = toProfileString(employeeData[field]);
  }
  profile.joiningDate = toDateInputValue(employeeData.joiningDate);
  return profile;
}

function dashboardEmployeeProfile(employeeData) {
  const profile = {};
  for (const field of DASHBOARD_PROFILE_FIELDS) {
    profile[field] = toProfileString(employeeData[field]);
  }
  return profile;
}

function attendanceForDashboard(data) {
  if (!data) return null;
  return {
    ...data,
    checkInFormatted: formatTimestamp(data.checkInAt),
    checkOutFormatted: formatTimestamp(data.checkOutAt)
  };
}

function attendanceLog(employeeUid, employeeData, dateKey, attendance, holidayInfo) {
  const isActive = employeeData.isActive !== false;
  if (!attendance && !isActive) return null;

  return {
    id: employeeUid,
    employeeName: employeeData.employeeName || employeeData.authEmail || 'Unknown',
    employeeId: employeeData.employeeId || employeeUid,
    designation: employeeData.designation || 'N/A',
    department: employeeData.department || 'N/A',
    dateKey,
    status: attendance?.status || (holidayInfo.isHoliday ? holidayInfo.statusText : 'absent'),
    lateByMinutes: attendance?.lateByMinutes || 0,
    checkInAt: attendance?.checkInAt ? formatTimestamp(attendance.checkInAt) : '-',
    checkOutAt: attendance?.checkOutAt ? formatTimestamp(attendance.checkOutAt) : (attendance ? 'Pending' : '-'),
    checkInLocation: attendance?.checkInLocation || null,
    checkOutLocation: attendance?.checkOutLocation || null
  };
}

async function loadDailyDashboard(dateKey) {
  const policyReference = db.collection('settings').doc('office');
  const overrideReference = policyReference.collection('date_overrides').doc(dateKey);
  const [policySnap, overrideSnap, employeesSnap] = await Promise.all([
    policyReference.get(),
    overrideReference.get(),
    db.collection(EMPLOYEES).get()
  ]);

  const officeSettings = policySnap.exists ? policySnap.data() : null;
  const dateOverrides = overrideSnap.exists
    ? [{ dateKey: overrideSnap.id, ...overrideSnap.data() }]
    : [];
  const holidayInfo = getHolidayStatus(dateKey, officeSettings, dateOverrides);
  const attendanceByEmployeeId = new Map();

  if (holidayInfo.isOfficeOpen) {
    const attendanceSnap = await db
      .collection(ATTENDANCE)
      .where('dateKey', '==', dateKey)
      .get();
    attendanceSnap.forEach(doc => {
      const data = doc.data();
      if (typeof data.employeeId === 'string') {
        attendanceByEmployeeId.set(data.employeeId, data);
      }
    });
  }

  let activeEmployees = 0;
  let checkedInCount = 0;
  let presentCount = 0;
  let lateCount = 0;
  let checkedOutCount = 0;
  const employees = [];
  const logs = [];

  employeesSnap.forEach(doc => {
    const employeeData = doc.data();
    const isActive = employeeData.isActive !== false;
    const attendance = attendanceByEmployeeId.get(doc.id) || null;
    if (isActive) activeEmployees++;
    if (attendance) {
      checkedInCount++;
      if (attendance.status === 'present') presentCount++;
      if (attendance.status === 'late') lateCount++;
      if (attendance.checkOutAt) checkedOutCount++;
    }

    let todayAttendance = attendanceForDashboard(attendance);
    if (!todayAttendance && holidayInfo.isHoliday && isActive) {
      todayAttendance = {
        status: holidayInfo.statusText,
        checkInFormatted: '-',
        checkOutFormatted: '-'
      };
    }

    employees.push({
      id: doc.id,
      authEmail: employeeData.authEmail || employeeData.personalEmail || 'N/A',
      isActive,
      hasFcmToken: Boolean(employeeData.fcmToken),
      profile: dashboardEmployeeProfile(employeeData),
      todayAttendance
    });

    const log = attendanceLog(doc.id, employeeData, dateKey, attendance, holidayInfo);
    if (log) logs.push(log);
  });

  const absentCount = holidayInfo.isHoliday
    ? 0
    : Math.max(0, activeEmployees - checkedInCount);

  return {
    dateKey,
    stats: {
      totalEmployees: employeesSnap.size,
      activeEmployees,
      checkedInCount,
      presentCount,
      lateCount,
      checkedOutCount,
      absentCount,
      isHoliday: holidayInfo.isHoliday,
      holidayReason: holidayInfo.reason,
      holidayStatusText: holidayInfo.statusText,
      hasDateOverride: holidayInfo.hasOverride,
      isOfficeOpen: holidayInfo.isOfficeOpen,
      attendanceEnabled: holidayInfo.isOfficeOpen,
      notice: holidayInfo.notice
    },
    officeSettings,
    employees,
    logs
  };
}

// Initial dashboard payload: one employee read, one direct override read, one
// policy read, and one date-scoped attendance query when the office is open.
app.get('/api/dashboard', async (req, res) => {
  try {
    const dashboard = await loadDailyDashboard(req.query.date || getDhakaDateKey());
    res.json({ success: true, ...dashboard });
  } catch (error) {
    console.error('Error fetching dashboard:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// API 1: Overview Statistics
app.get('/api/stats', async (req, res) => {
  try {
    const dashboard = await loadDailyDashboard(req.query.date || getDhakaDateKey());
    res.json({
      success: true,
      dateKey: dashboard.dateKey,
      stats: dashboard.stats,
      officeSettings: dashboard.officeSettings
    });
  } catch (error) {
    console.error('Error fetching stats:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// API 2: Employee List with Profile & Status
app.get('/api/employees', async (req, res) => {
  try {
    const dateKey = req.query.date || getDhakaDateKey();
    const employeesSnap = await db.collection(EMPLOYEES).get();
    const employees = [];

    for (const empDoc of employeesSnap.docs) {
      const empData = empDoc.data();
      const empId = empDoc.id;

      employees.push({
        id: empId,
        authEmail: empData.authEmail || empData.personalEmail || 'N/A',
        isActive: empData.isActive !== false,
        hasFcmToken: Boolean(empData.fcmToken),
        profile: employeeProfile(empData),
        todayAttendance: null
      });
    }

    res.json({ success: true, dateKey, employees });
  } catch (error) {
    console.error('Error fetching employees:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// API 2.1: Employee detail. Sensitive profile fields are intentionally kept
// out of the cached dashboard payload and fetched only for this explicit view.
app.get('/api/employees/:id', async (req, res) => {
  try {
    const employeeSnap = await db.collection(EMPLOYEES).doc(req.params.id).get();
    if (!employeeSnap.exists) {
      return res.status(404).json({ success: false, error: 'Employee not found.' });
    }

    const employeeData = employeeSnap.data();
    res.set('Cache-Control', 'private, no-store');
    res.json({
      success: true,
      employee: {
        id: employeeSnap.id,
        authEmail: employeeData.authEmail || employeeData.personalEmail || 'N/A',
        isActive: employeeData.isActive !== false,
        hasFcmToken: Boolean(employeeData.fcmToken),
        profile: employeeProfile(employeeData)
      }
    });
  } catch (error) {
    console.error('Error fetching employee detail:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// API 3: Toggle Employee Active Status
app.post('/api/employees/:id/toggle-status', async (req, res) => {
  try {
    const { id } = req.params;
    const { isActive } = req.body;

    await db.collection('employees').doc(id).set(
      {
        isActive: Boolean(isActive),
        updatedAt: FieldValue.serverTimestamp()
      },
      { merge: true }
    );

    res.json({ success: true, id, isActive });
  } catch (error) {
    console.error('Error toggling status:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// API 3.0: Create New Employee (with Firebase Auth)
app.post('/api/employees', async (req, res) => {
  try {
    const { employeeName, personalEmail, joiningDate } = req.body;

    const emailToUse = personalEmail;
    if (!emailToUse) {
      return res.status(400).json({ success: false, error: "A personal email is required to create an account." });
    }

    const { getAuth } = require('firebase-admin/auth');
    
    // Create user in Firebase Auth with default password '123456'
    let userRecord;
    try {
      userRecord = await getAuth().createUser({
        email: emailToUse,
        password: '123456',
        displayName: employeeName || 'Employee'
      });
    } catch (authErr) {
      return res.status(400).json({ success: false, error: `Auth Error: ${authErr.message}` });
    }

    const uid = userRecord.uid;

    // Write every field the app expects, blank string instead of missing.
    const profileData = {
      schemaVersion: 1,
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
      joiningDate: toJoiningTimestamp(joiningDate)
    };
    for (const field of PROFILE_STRING_FIELDS) {
      profileData[field] = toProfileString(req.body[field]);
    }
    if (!profileData.profileImagePath) {
      profileData.profileImagePath = DEFAULT_PROFILE_IMAGE_PATH;
    }

    // Profile and account metadata live in one canonical employee document.
    const employeeData = {
      ...profileData,
      isActive: true,
      authEmail: emailToUse
    };

    await db.collection(EMPLOYEES).doc(uid).set(employeeData);

    res.json({ success: true, id: uid });
  } catch (error) {
    console.error('Error creating employee:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// API 3.1: Update Employee Profile
app.put('/api/employees/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { joiningDate } = req.body;

    const employeeReference = db.collection(EMPLOYEES).doc(id);
    const employeeSnap = await employeeReference.get();
    if (!employeeSnap.exists) {
      return res.status(404).json({ success: false, error: 'Employee not found.' });
    }
    const existingEmployee = employeeSnap.data();

    const profileData = {
      schemaVersion: 1,
      updatedAt: FieldValue.serverTimestamp()
    };
    for (const field of PROFILE_STRING_FIELDS) {
      const submitted = req.body[field];
      profileData[field] = submitted === undefined
        ? toProfileString(existingEmployee[field])
        : toProfileString(submitted);
    }
    if (!profileData.profileImagePath) {
      profileData.profileImagePath = DEFAULT_PROFILE_IMAGE_PATH;
    }
    if (joiningDate || existingEmployee.joiningDate === undefined) {
      profileData.joiningDate = toJoiningTimestamp(joiningDate);
    }

    // Update main employee doc. `authEmail` mirrors the Firebase Auth login
    // email, so it must never be replaced by the official (work) email here.
    const mainEmpData = {
      updatedAt: FieldValue.serverTimestamp()
    };
    if (typeof existingEmployee.isActive !== 'boolean') {
      mainEmpData.isActive = true;
    }

    await employeeReference.set({ ...profileData, ...mainEmpData }, { merge: true });

    res.json({ success: true, id });
  } catch (error) {
    console.error('Error updating employee:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// API 3.2: Delete Employee
app.delete('/api/employees/:id', async (req, res) => {
  try {
    const { id } = req.params;
    
    const attendanceSnap = await db
      .collection(ATTENDANCE)
      .where('employeeId', '==', id)
      .get();
    const writer = db.bulkWriter();
    attendanceSnap.docs.forEach(doc => writer.delete(doc.ref));
    writer.delete(db.collection(EMPLOYEES).doc(id));
    await writer.close();
    
    // Delete from Firebase Auth
    const { getAuth } = require('firebase-admin/auth');
    try {
      await getAuth().deleteUser(id);
      console.log(`Successfully deleted user ${id} from Firebase Auth`);
    } catch (authErr) {
      console.log(`Note: Could not delete from Firebase Auth (might not exist): ${authErr.message}`);
    }
    
    res.json({ success: true, id });
  } catch (error) {
    console.error('Error deleting employee:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// API 3.3: Get Employee Monthly Attendance
app.get('/api/employees/:id/attendance', async (req, res) => {
  try {
    const { id } = req.params;
    const { month } = req.query; // e.g., 'YYYY-MM'

    if (!month || !/^\d{4}-\d{2}$/.test(month)) {
      return res.status(400).json({ success: false, error: 'Valid month query parameter required (YYYY-MM)' });
    }

    const startKey = `${month}-01`;
    const endKey = `${month}-31`;

    const attendanceSnap = await db.collection(ATTENDANCE)
      .where('employeeId', '==', id)
      .where('dateKey', '>=', startKey)
      .where('dateKey', '<=', endKey)
      .orderBy('dateKey', 'desc')
      .get();

    const records = [];
    attendanceSnap.forEach(doc => {
      const data = doc.data();
      records.push({
        dateKey: data.dateKey,
        checkInAt: data.checkInAt ? data.checkInAt.toDate().toISOString() : null,
        checkOutAt: data.checkOutAt ? data.checkOutAt.toDate().toISOString() : null,
        status: data.status,
        lateByMinutes: data.lateByMinutes,
        location: data.checkInLocation?.address || 'N/A'
      });
    });

    res.json({ success: true, records });
  } catch (error) {
    console.error('Error fetching employee attendance:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// API 4: Attendance History Log
app.get('/api/attendance', async (req, res) => {
  try {
    const targetDate = req.query.date || getDhakaDateKey();
    const dashboard = await loadDailyDashboard(targetDate);
    res.json({ success: true, date: targetDate, logs: dashboard.logs });
  } catch (error) {
    console.error('Error fetching attendance logs:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// API 4.1: Edit Attendance
app.put('/api/attendance/edit', async (req, res) => {
  try {
    const { employeeId, dateKey, checkInTime, checkOutTime } = req.body;
    if (!employeeId || !dateKey) {
      return res.status(400).json({ success: false, error: 'employeeId and dateKey are required' });
    }

    const createTimestamp = (timeStr) => {
      if (!timeStr || timeStr === '-') return null;
      const dhakaDateStr = `${dateKey}T${timeStr}:00+06:00`;
      const dateObj = new Date(dhakaDateStr);
      if (isNaN(dateObj.getTime())) return null;
      return Timestamp.fromDate(dateObj);
    };

    // Fetch office policy to calculate proper status (same logic as Flutter classifyCheckIn)
    const policySnap = await db.collection('settings').doc('office').get();
    const officePolicy = policySnap.exists ? policySnap.data() : null;

    const updateData = {};
    if (checkInTime && checkInTime !== '-') updateData.checkInAt = createTimestamp(checkInTime);
    if (checkOutTime && checkOutTime !== '-') updateData.checkOutAt = createTimestamp(checkOutTime);

    if (updateData.checkInAt && checkInTime && checkInTime !== '-') {
      // classifyCheckIn: same as Firebase function logic
      // checkInTime is "HH:MM" (24h)
      const [inHour, inMin] = checkInTime.split(':').map(Number);
      const checkInMinuteOfDay = inHour * 60 + inMin;

      let status = 'present';
      let lateByMinutes = 0;

      if (officePolicy && officePolicy.startTimeLocal) {
        const [startH, startM] = officePolicy.startTimeLocal.split(':').map(Number);
        const startMinuteOfDay = startH * 60 + startM;
        const lateThreshold = officePolicy.lateThresholdMinutes ?? 0;

        const delayMinutes = Math.max(0, checkInMinuteOfDay - startMinuteOfDay);
        if (delayMinutes > lateThreshold) {
          status = 'late';
          lateByMinutes = delayMinutes;
        }
      }

      updateData.status = status;
      updateData.lateByMinutes = lateByMinutes;
    }

    const attendanceRef = db
      .collection(ATTENDANCE)
      .doc(`${dateKey}_${employeeId}`);

    const attendanceSnap = await attendanceRef.get();
    if (!attendanceSnap.exists) {
      // A half-written record (no schemaVersion / checkInLocation) makes the app
      // throw on the whole attendance history, so never create one here.
      return res.status(404).json({
        success: false,
        error: 'No attendance record exists for this date. Only an existing check-in can be edited.'
      });
    }

    // The app validates `schemaVersion == 1` on every record it reads.
    if (attendanceSnap.data().schemaVersion !== 1) {
      updateData.schemaVersion = 1;
    }

    await attendanceRef.set(updateData, { merge: true });

    res.json({ success: true, employeeId, dateKey });
  } catch (error) {
    console.error('Error editing attendance:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// API: Delete Attendance Record
app.delete('/api/attendance/delete', async (req, res) => {
  try {
    const { employeeId, dateKey } = req.body;
    if (!employeeId || !dateKey) {
      return res.status(400).json({ success: false, error: 'employeeId and dateKey are required' });
    }

    await db
      .collection(ATTENDANCE)
      .doc(`${dateKey}_${employeeId}`)
      .delete();

    res.json({ success: true, employeeId, dateKey });
  } catch (error) {
    console.error('Error deleting attendance:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

async function loadOfficePolicy() {
  const officeDoc = await db.collection('settings').doc('office').get();
  return officeDoc.exists ? officeDoc.data() : null;
}

async function loadDateOverrides() {
  const overridesSnap = await db
    .collection('settings')
    .doc('office')
    .collection('date_overrides')
    .get();

  const dateOverrides = [];
  overridesSnap.forEach(doc => {
    dateOverrides.push({ dateKey: doc.id, ...doc.data() });
  });
  return dateOverrides.sort((left, right) => left.dateKey.localeCompare(right.dateKey));
}

// API 5: Office Settings & Date Overrides. The Worker loads these two parts
// independently so the rarely changed policy and override list can have
// different cache lifetimes while the public response contract stays simple.
app.get('/api/settings/office', async (req, res) => {
  try {
    const [settings, dateOverrides] = await Promise.all([
      loadOfficePolicy(),
      loadDateOverrides()
    ]);

    res.json({ success: true, settings, dateOverrides });
  } catch (error) {
    console.error('Error fetching office settings:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// API 6: Update Office Settings
app.post('/api/settings/office', async (req, res) => {
  try {
    const {
      latitude,
      longitude,
      allowedRadiusMeters,
      startTimeLocal,
      endTimeLocal,
      lateThresholdMinutes,
      checkInOpensBeforeMinutes,
      weeklyOfficeDays
    } = req.body;

    const updateData = {
      schemaVersion: 1,
      timeZone: 'Asia/Dhaka',
      latitude: Number(latitude),
      longitude: Number(longitude),
      allowedRadiusMeters: Number(allowedRadiusMeters),
      startTimeLocal: String(startTimeLocal),
      endTimeLocal: String(endTimeLocal),
      lateThresholdMinutes: Number(lateThresholdMinutes),
      checkInOpensBeforeMinutes: Number(checkInOpensBeforeMinutes),
      weeklyOfficeDays: Array.isArray(weeklyOfficeDays) ? weeklyOfficeDays.map(Number) : [1, 2, 3, 4, 5, 6, 7]
    };

    // The app rejects the office policy if it carries any key outside this exact
    // set, so overwrite the document instead of merging.
    await db.collection('settings').doc('office').set(updateData);
    res.json({ success: true, settings: updateData });
  } catch (error) {
    console.error('Error updating office settings:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// API 7: Add Date Override
app.post('/api/settings/date-override', async (req, res) => {
  try {
    const { dateKey, isOfficeOpen, reason } = req.body;
    if (!dateKey) {
      return res.status(400).json({ success: false, error: 'dateKey is required' });
    }

    const payload = {
      schemaVersion: 1,
      isOfficeOpen: Boolean(isOfficeOpen),
      reason: String(reason || 'Holiday / Special Closure')
    };

    await db
      .collection('settings')
      .doc('office')
      .collection('date_overrides')
      .doc(dateKey)
      .set(payload);

    res.json({ success: true, dateKey, override: payload });
  } catch (error) {
    console.error('Error adding date override:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// API 8: Delete Date Override
app.delete('/api/settings/date-override/:dateKey', async (req, res) => {
  try {
    const { dateKey } = req.params;
    await db
      .collection('settings')
      .doc('office')
      .collection('date_overrides')
      .doc(dateKey)
      .delete();

    res.json({ success: true, dateKey });
  } catch (error) {
    console.error('Error deleting date override:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════
// PUSH NOTIFICATIONS
// ═══════════════════════════════════════════════════════════════════════

const NOTIFICATION_LOGS = 'notification_logs';
const SCHEDULED_NOTIFICATIONS = 'scheduled_notifications';
const OFFICE_BROADCAST_TOPIC = 'active_office_employees';
const NOTIFICATION_TARGETS = new Set([
  'all_users',
  'selected_users',
  'office_broadcast',
  'office_check_in_reminder',
  'office_check_out_reminder'
]);
const MAX_SELECTED_RECIPIENTS = 500;
const FCM_MULTICAST_CHUNK = 500;
const SCHEDULER_TICK_MS = 5 * 60 * 1000;
const SCHEDULER_BATCH_LIMIT = 100;
const SCHEDULER_LEASE_MS = 10 * 60 * 1000;
const SCHEDULER_MAX_ATTEMPTS = 4;
const SCHEDULER_RETRY_DELAYS_MS = [60_000, 5 * 60_000, 15 * 60_000, 60 * 60_000];

function optionalString(value, maxLength) {
  if (typeof value !== 'string') return '';
  return value.trim().slice(0, maxLength);
}

function notificationTarget(value) {
  return typeof value === 'string' && NOTIFICATION_TARGETS.has(value)
    ? value
    : null;
}

function selectedEmployeeIds(source) {
  const rawIds = Array.isArray(source.recipientUids) ? source.recipientUids : [];

  return [...new Set(rawIds)]
    .filter(uid => typeof uid === 'string' && uid.trim().length > 0)
    .map(uid => uid.trim())
    .slice(0, MAX_SELECTED_RECIPIENTS);
}

function buildFcmPayload({ title, body, imageUrl, actionUrl, occurrenceId }) {
  const notification = { title, body };
  if (imageUrl) notification.imageUrl = imageUrl;

  const data = { type: 'push' };
  if (imageUrl) data.imageUrl = imageUrl;
  if (actionUrl) data.actionUrl = actionUrl;
  if (occurrenceId) data.occurrenceId = occurrenceId;

  const deliveryOptions = occurrenceId
    ? {
        android: {
          collapseKey: occurrenceId,
          notification: { tag: occurrenceId }
        },
        apns: {
          headers: { 'apns-collapse-id': occurrenceId.slice(0, 64) }
        }
      }
    : {};

  return { notification, data, deliveryOptions };
}

async function dispatchThroughFirebaseFunction({ tokens, topic, notification, data }) {
  const url = optionalString(process.env.FCM_DISPATCH_URL, 2048);
  const secret = optionalString(process.env.FCM_DISPATCH_SECRET, 4096);
  if (!url || !secret) throw new Error('Firebase notification dispatcher is not configured');

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-dashboard-dispatch-secret': secret
    },
    body: JSON.stringify({
      tokens,
      topic,
      title: notification.title,
      body: notification.body,
      imageUrl: notification.imageUrl || null,
      occurrenceId: data.occurrenceId || null,
      data
    })
  });

  let result = null;
  try {
    result = await response.json();
  } catch {
    // The status code below remains actionable for a non-JSON response.
  }
  if (!response.ok || !result?.success) {
    throw new Error(result?.message || `Firebase dispatcher returned HTTP ${response.status}`);
  }
  return {
    successCount: Number(result.successCount) || 0,
    failureCount: Number(result.failureCount) || 0
  };
}

// The dashboard treats a bare 'YYYY-MM-DDTHH:mm' as Dhaka wall-clock time, the
// same reading `toJoiningTimestamp` and the attendance editor use.
function toDhakaDate(value) {
  if (!value) return null;
  const raw = String(value).trim();
  const hasZone = /(Z|[+-]\d{2}:?\d{2})$/.test(raw);
  if (hasZone) {
    const parsed = new Date(raw);
    return isNaN(parsed.getTime()) ? null : parsed;
  }
  const withSeconds = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(raw) ? `${raw}:00` : raw;
  const parsed = new Date(`${withSeconds}+06:00`);
  return isNaN(parsed.getTime()) ? null : parsed;
}

async function writeNotificationLog(data) {
  await db.collection(NOTIFICATION_LOGS).add({
    ...data,
    timestamp: FieldValue.serverTimestamp()
  });
}

// Resolves the device tokens for a send. `failureCount` counts employees that
// cannot be reached at all — deleted, deactivated, or never registered a device.
async function resolveRecipients(target, recipientUids) {
  if (target === 'selected_users') {
    if (recipientUids.length === 0) {
      return { tokens: [], recipientNames: [], failureCount: 0 };
    }

    const employeeDocs = await db.getAll(
      ...recipientUids.map(uid => db.collection(EMPLOYEES).doc(uid))
    );

    const tokens = [];
    const recipientNames = [];
    let failureCount = 0;

    for (let index = 0; index < recipientUids.length; index++) {
      const uid = recipientUids[index];
      const employeeDoc = employeeDocs[index];

      if (!employeeDoc.exists) {
        recipientNames.push(uid);
        failureCount++;
        continue;
      }

      const employee = employeeDoc.data() || {};
      recipientNames.push(employee.employeeName || employee.authEmail || uid);

      if (!employee.fcmToken) {
        failureCount++;
        continue;
      }
      tokens.push(employee.fcmToken);
    }

    return { tokens: [...new Set(tokens)], recipientNames, failureCount };
  }

  // All employees — every active employee that has registered a device.
  const employeesSnap = await db.collection(EMPLOYEES).get();
  const tokens = [];
  let failureCount = 0;

  employeesSnap.forEach(doc => {
    const employee = doc.data() || {};
    if (employee.isActive === false) return;
    if (!employee.fcmToken) {
      failureCount++;
      return;
    }
    tokens.push(employee.fcmToken);
  });

  return { tokens: [...new Set(tokens)], recipientNames: [], failureCount };
}

function dhakaDateKey(value) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Dhaka',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).format(value);
}

async function resolveAttendanceReminderRecipients(target, occurrenceAt) {
  const dateKey = dhakaDateKey(occurrenceAt);
  const [officeDocument, overrideDocument] = await Promise.all([
    db.collection('settings').doc('office').get(),
    db.collection('settings').doc('office').collection('date_overrides').doc(dateKey).get()
  ]);
  const dateOverrides = overrideDocument.exists
    ? [{ dateKey: overrideDocument.id, ...overrideDocument.data() }]
    : [];
  const officeStatus = getHolidayStatus(
    dateKey,
    officeDocument.exists ? officeDocument.data() : null,
    dateOverrides
  );
  if (!officeStatus.isOfficeOpen) {
    return {
      tokens: [],
      recipientNames: [],
      failureCount: 0,
      eligibleCount: 0,
      skippedReason: 'office_closed'
    };
  }

  const attendanceSnapshot = await db
    .collection(ATTENDANCE)
    .where('dateKey', '==', dateKey)
    .get();

  if (target === 'office_check_in_reminder') {
    const checkedInEmployeeIds = new Set();
    attendanceSnapshot.forEach(doc => {
      const attendance = doc.data() || {};
      if (attendance.employeeId && attendance.checkInAt) {
        checkedInEmployeeIds.add(attendance.employeeId);
      }
    });

    const employeesSnapshot = await db.collection(EMPLOYEES).get();
    const tokens = [];
    let failureCount = 0;
    let eligibleCount = 0;
    employeesSnapshot.forEach(doc => {
      const employee = doc.data() || {};
      if (employee.isActive === false || checkedInEmployeeIds.has(doc.id)) return;
      eligibleCount++;
      if (!employee.fcmToken) {
        failureCount++;
        return;
      }
      tokens.push(employee.fcmToken);
    });
    return { tokens: [...new Set(tokens)], recipientNames: [], failureCount, eligibleCount };
  }

  const pendingCheckoutIds = [];
  attendanceSnapshot.forEach(doc => {
    const attendance = doc.data() || {};
    if (attendance.employeeId && attendance.checkInAt && !attendance.checkOutAt) {
      pendingCheckoutIds.push(attendance.employeeId);
    }
  });
  if (pendingCheckoutIds.length === 0) {
    return { tokens: [], recipientNames: [], failureCount: 0, eligibleCount: 0 };
  }

  const employeeDocs = await db.getAll(
    ...pendingCheckoutIds.map(uid => db.collection(EMPLOYEES).doc(uid))
  );
  const tokens = [];
  let failureCount = 0;
  let eligibleCount = 0;
  employeeDocs.forEach(employeeDoc => {
    if (!employeeDoc.exists) {
      failureCount++;
      return;
    }
    const employee = employeeDoc.data() || {};
    if (employee.isActive === false) return;
    eligibleCount++;
    if (!employee.fcmToken) {
      failureCount++;
      return;
    }
    tokens.push(employee.fcmToken);
  });
  return { tokens: [...new Set(tokens)], recipientNames: [], failureCount, eligibleCount };
}

async function sendToTokens(tokens, notification, data, deliveryOptions) {
  let successCount = 0;
  let failureCount = 0;

  if (isCloudflareWorker) {
    return dispatchThroughFirebaseFunction({ tokens, notification, data });
  }

  for (let index = 0; index < tokens.length; index += FCM_MULTICAST_CHUNK) {
    const chunk = tokens.slice(index, index + FCM_MULTICAST_CHUNK);
    const result = await getMessaging().sendEachForMulticast({
      notification,
      data,
      ...deliveryOptions,
      tokens: chunk
    });
    successCount += result.successCount;
    failureCount += result.failureCount;
  }

  return { successCount, failureCount };
}

// Shared by the immediate send endpoint and the scheduled-notification runner.
async function deliverNotification({
  target,
  title,
  body,
  imageUrl,
  actionUrl,
  recipientUids,
  occurrenceAt = new Date(),
  occurrenceId = crypto.randomUUID()
}) {
  const { notification, data, deliveryOptions } = buildFcmPayload({
    title,
    body,
    imageUrl,
    actionUrl,
    occurrenceId
  });

  if (target === 'office_broadcast') {
    if (isCloudflareWorker) {
      await dispatchThroughFirebaseFunction({
        topic: OFFICE_BROADCAST_TOPIC,
        notification,
        data
      });
    } else {
      await getMessaging().send({
        notification,
        data,
        ...deliveryOptions,
        topic: OFFICE_BROADCAST_TOPIC
      });
    }
    return {
      successCount: 0,
      failureCount: 0,
      recipientNames: [],
      deliveryMode: 'topic'
    };
  }

  const resolved = target === 'office_check_in_reminder' || target === 'office_check_out_reminder'
    ? await resolveAttendanceReminderRecipients(target, occurrenceAt)
    : await resolveRecipients(target, recipientUids);

  if (resolved.tokens.length === 0) {
    if (resolved.eligibleCount === 0) {
      return {
        successCount: 0,
        failureCount: 0,
        recipientNames: [],
        deliveryMode: 'tokens',
        skippedReason: resolved.skippedReason || 'attendance_already_complete'
      };
    }
    const error = new Error('No employees could be reached');
    error.code = 'no_recipients';
    error.recipientNames = resolved.recipientNames;
    error.failureCount = Math.max(resolved.failureCount, 1);
    throw error;
  }

  const sendResult = await sendToTokens(
    resolved.tokens,
    notification,
    data,
    deliveryOptions
  );
  if (sendResult.successCount === 0) {
    const error = new Error('Firebase Cloud Messaging rejected every recipient');
    error.code = 'delivery_failed';
    error.failureCount = resolved.failureCount + sendResult.failureCount;
    throw error;
  }

  return {
    successCount: sendResult.successCount,
    failureCount: resolved.failureCount + sendResult.failureCount,
    recipientNames: resolved.recipientNames,
    deliveryMode: 'tokens',
    skippedReason: null
  };
}

// API 9: Send Notification (immediate)
app.post('/api/notifications/send', async (req, res) => {
  const payload = req.body || {};
  const title = optionalString(payload.title, 200);
  const body = optionalString(payload.body, 2000);
  const imageUrl = optionalString(payload.imageUrl, 2048);
  const actionUrl = optionalString(payload.actionUrl, 2048);

  if (!title || !body) {
    return res.status(400).json({ success: false, message: 'title and body are required' });
  }

  const target = notificationTarget(payload.target);
  if (!target) {
    return res.status(400).json({ success: false, message: 'Invalid notification target' });
  }
  const recipientUids = target === 'selected_users' ? selectedEmployeeIds(payload) : [];

  if (target === 'selected_users' && recipientUids.length === 0) {
    return res.status(400).json({ success: false, message: 'At least one employee must be selected' });
  }

  try {
    const result = await deliverNotification({
      target,
      title,
      body,
      imageUrl,
      actionUrl,
      recipientUids
    });

    await writeNotificationLog({
      target,
      title,
      body,
      imageUrl: imageUrl || null,
      actionUrl: actionUrl || null,
      recipientUids: target === 'selected_users' ? recipientUids : null,
      recipientNames: result.recipientNames.length > 0 ? result.recipientNames : null,
      status: 'success',
      successCount: result.successCount,
      failureCount: result.failureCount,
      deliveryMode: result.deliveryMode,
      skippedReason: result.skippedReason || null,
      source: 'dashboard'
    });

    const message = result.skippedReason === 'office_closed'
      ? 'No reminder was needed because the office is closed on this date'
      : result.skippedReason === 'attendance_already_complete'
        ? 'No reminder was needed because every relevant employee already completed attendance'
      : result.deliveryMode === 'topic'
      ? 'Office broadcast accepted by Firebase Cloud Messaging'
      : `Notification sent to ${result.successCount} employee(s)` +
        (result.failureCount > 0 ? `, ${result.failureCount} could not be reached` : '');

    res.json({ success: true, message, data: result });
  } catch (error) {
    console.error('Error sending notification:', error);

    try {
      await writeNotificationLog({
        target,
        title,
        body,
        imageUrl: imageUrl || null,
        actionUrl: actionUrl || null,
        recipientUids: target === 'selected_users' ? recipientUids : null,
        recipientNames: error.recipientNames && error.recipientNames.length > 0 ? error.recipientNames : null,
        status: 'failed',
        error: error.message || 'Unknown error',
        successCount: 0,
        failureCount: error.failureCount || 1,
        deliveryMode: target === 'office_broadcast' ? 'topic' : 'tokens',
        source: 'dashboard'
      });
    } catch (logError) {
      console.error('Could not write notification failure log:', logError);
    }

    if (error.code === 'no_recipients') {
      return res.status(400).json({
        success: false,
        message: target === 'selected_users'
          ? 'No device token available for the selected employee(s)'
          : target === 'office_check_in_reminder'
            ? 'Every active employee has already checked in or has no registered device'
            : target === 'office_check_out_reminder'
              ? 'No checked-in employee is waiting to check out'
              : 'No active employee has registered a device yet'
      });
    }

    res.status(500).json({ success: false, message: error.message || 'Failed to send notification' });
  }
});

function encodeNotificationCursor(document, fieldName) {
  const value = document.data()?.[fieldName];
  const date = value?.toDate?.();
  if (!(date instanceof Date) || isNaN(date.getTime())) return null;
  const timestamp = typeof value.toISOString === 'function'
    ? value.toISOString()
    : date.toISOString();
  const cursor = { v: 1, at: timestamp, id: document.id };
  if (Number.isInteger(value.seconds) && Number.isInteger(value.nanoseconds)) {
    cursor.seconds = value.seconds;
    cursor.nanoseconds = value.nanoseconds;
  }
  return Buffer.from(JSON.stringify(cursor))
    .toString('base64url');
}

function decodeNotificationCursor(token, collectionName) {
  if (!token) return null;
  try {
    const parsed = JSON.parse(Buffer.from(String(token), 'base64url').toString('utf8'));
    const date = new Date(parsed.at);
    if (parsed.v !== 1 || typeof parsed.id !== 'string' || parsed.id.includes('/') || isNaN(date.getTime())) {
      return null;
    }
    const timestamp = typeof Timestamp.fromISOString === 'function'
      ? Timestamp.fromISOString(parsed.at)
      : Number.isInteger(parsed.seconds) && Number.isInteger(parsed.nanoseconds)
        ? new Timestamp(parsed.seconds, parsed.nanoseconds)
        : Timestamp.fromDate(date);
    return {
      timestamp,
      reference: db.collection(collectionName).doc(parsed.id)
    };
  } catch {
    return null;
  }
}

function notificationLogResponse(document) {
  const data = document.data() || {};
  return {
    id: document.id,
    target: data.target,
    title: data.title || '',
    body: data.body || '',
    imageUrl: data.imageUrl || null,
    actionUrl: data.actionUrl || null,
    recipientUids: data.recipientUids || null,
    recipientNames: data.recipientNames || null,
    status: data.status || 'unknown',
    error: data.error || null,
    successCount: data.successCount || 0,
    failureCount: data.failureCount || 0,
    deliveryMode: data.deliveryMode || 'tokens',
    skippedReason: data.skippedReason || null,
    scheduledNotificationId: data.scheduledNotificationId || null,
    occurrenceId: data.occurrenceId || null,
    timestamp: data.timestamp?.toDate?.()?.toISOString() || null
  };
}

function matchesNotificationLog(log, { target, status, search }) {
  if (target && log.target !== target) return false;
  if (status && log.status !== status) return false;
  if (!search) return true;
  return log.title.toLowerCase().includes(search) ||
    log.body.toLowerCase().includes(search) ||
    (log.recipientNames || []).some(name => String(name).toLowerCase().includes(search));
}

// API 10: Notification History (bounded cursor scan + filtered response)
app.get('/api/notifications/history', async (req, res) => {
  try {
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 20, 1), 100);
    const targetFilter = (req.query.target || '').trim();
    const statusFilter = (req.query.status || '').trim();
    const search = (req.query.search || '').trim().toLowerCase();
    const dateFrom = (req.query.dateFrom || '').trim();
    const dateTo = (req.query.dateTo || '').trim();

    if (targetFilter && !NOTIFICATION_TARGETS.has(targetFilter)) {
      return res.status(400).json({ success: false, message: 'Invalid target filter' });
    }
    if (statusFilter && !['success', 'failed'].includes(statusFilter)) {
      return res.status(400).json({ success: false, message: 'Invalid status filter' });
    }

    const requestedCursor = req.query.cursor
      ? decodeNotificationCursor(req.query.cursor, NOTIFICATION_LOGS)
      : null;
    if (req.query.cursor && !requestedCursor) {
      return res.status(400).json({ success: false, message: 'Invalid history cursor' });
    }

    let scanCursor = requestedCursor;
    let lastScannedCursorToken = null;
    let scanned = 0;
    let exhausted = false;
    const matches = [];
    const scanBatchSize = 100;
    const maxScannedDocuments = 500;
    const fromDate = dateFrom ? toDhakaDate(`${dateFrom.slice(0, 10)}T00:00`) : null;
    const toDate = dateTo ? toDhakaDate(`${dateTo.slice(0, 10)}T23:59:59`) : null;

    while (matches.length <= limit && scanned < maxScannedDocuments && !exhausted) {
      let query = db
        .collection(NOTIFICATION_LOGS)
        .orderBy('timestamp', 'desc')
        .orderBy('__name__', 'desc');
      if (fromDate) query = query.where('timestamp', '>=', Timestamp.fromDate(fromDate));
      if (toDate) query = query.where('timestamp', '<=', Timestamp.fromDate(toDate));
      if (scanCursor) query = query.startAfter(scanCursor.timestamp, scanCursor.reference);

      const snapshot = await query.limit(scanBatchSize).get();
      if (snapshot.empty) {
        exhausted = true;
        break;
      }

      for (const document of snapshot.docs) {
        scanned++;
        const cursorToken = encodeNotificationCursor(document, 'timestamp');
        const log = notificationLogResponse(document);
        lastScannedCursorToken = cursorToken;
        scanCursor = decodeNotificationCursor(cursorToken, NOTIFICATION_LOGS);
        if (matchesNotificationLog(log, {
          target: targetFilter,
          status: statusFilter,
          search
        })) {
          matches.push({ log, cursor: cursorToken });
          if (matches.length > limit) break;
        }
        if (scanned >= maxScannedDocuments) break;
      }

      if (snapshot.size < scanBatchSize) exhausted = true;
    }

    const pageItems = matches.slice(0, limit);
    const hasExtraMatch = matches.length > limit;
    const mayHaveMoreDocuments = !exhausted && scanned >= maxScannedDocuments;
    const nextCursor = hasExtraMatch
      ? pageItems.at(-1)?.cursor || null
      : mayHaveMoreDocuments
        ? lastScannedCursorToken
        : null;

    res.json({
      success: true,
      data: {
        logs: pageItems.map(item => item.log),
        nextCursor,
        hasMore: Boolean(nextCursor),
        scannedCount: scanned
      }
    });
  } catch (error) {
    console.error('Error fetching notification history:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// API 11: Schedule a Notification
app.post('/api/notifications/schedule', async (req, res) => {
  try {
    const payload = req.body || {};
    const title = optionalString(payload.title, 200);
    const body = optionalString(payload.body, 2000);
    const imageUrl = optionalString(payload.imageUrl, 2048);
    const actionUrl = optionalString(payload.actionUrl, 2048);
    const isRecurring = Boolean(payload.isRecurring);
    const recurringType = payload.recurringType;

    if (!title || !body) {
      return res.status(400).json({ success: false, message: 'title and body are required' });
    }
    if (!payload.scheduledAt) {
      return res.status(400).json({ success: false, message: 'scheduledAt is required' });
    }

    const scheduledDate = toDhakaDate(payload.scheduledAt);
    if (!scheduledDate) {
      return res.status(400).json({ success: false, message: 'Invalid scheduledAt date format' });
    }
    if (scheduledDate <= new Date()) {
      return res.status(400).json({ success: false, message: 'scheduledAt must be in the future' });
    }
    if (isRecurring && !['daily', 'weekly', 'monthly'].includes(recurringType)) {
      return res.status(400).json({
        success: false,
        message: "recurringType must be 'daily', 'weekly', or 'monthly'"
      });
    }

    const target = notificationTarget(payload.target);
    if (!target) {
      return res.status(400).json({ success: false, message: 'Invalid notification target' });
    }
    const recipientUids = target === 'selected_users' ? selectedEmployeeIds(payload) : [];

    if (target === 'selected_users' && recipientUids.length === 0) {
      return res.status(400).json({ success: false, message: 'At least one employee must be selected' });
    }

    // Resolve the display names now so the scheduled row stays readable even if
    // an employee is renamed or removed before it fires.
    const recipientNames = [];
    if (target === 'selected_users') {
      const employeeDocs = await db.getAll(
        ...recipientUids.map(uid => db.collection(EMPLOYEES).doc(uid))
      );
      employeeDocs.forEach((doc, index) => {
        recipientNames.push((doc.exists && doc.data().employeeName) || recipientUids[index]);
      });
    }

    const docRef = await db.collection(SCHEDULED_NOTIFICATIONS).add({
      target,
      title,
      body,
      imageUrl: imageUrl || null,
      actionUrl: actionUrl || null,
      recipientUids: target === 'selected_users' ? recipientUids : null,
      recipientNames: recipientNames.length > 0 ? recipientNames : null,
      scheduledAt: Timestamp.fromDate(scheduledDate),
      status: 'pending',
      attemptCount: 0,
      maxAttempts: SCHEDULER_MAX_ATTEMPTS,
      claimToken: null,
      leaseUntil: null,
      lastAttemptAt: null,
      lastError: null,
      occurrenceScheduledAt: Timestamp.fromDate(scheduledDate),
      isRecurring,
      recurringType: isRecurring ? recurringType : null,
      createdAt: FieldValue.serverTimestamp()
    });

    const audience = target === 'selected_users'
      ? `${recipientUids.length} employee(s)`
      : target === 'office_broadcast'
        ? 'the office broadcast topic'
        : target === 'office_check_in_reminder'
          ? 'employees who have not checked in'
          : target === 'office_check_out_reminder'
            ? 'employees waiting to check out'
            : 'all employees';

    res.json({
      success: true,
      message: `Notification for ${audience} scheduled at ${scheduledDate.toISOString()}`,
      data: { id: docRef.id }
    });
  } catch (error) {
    console.error('Error scheduling notification:', error);
    res.status(500).json({ success: false, message: error.message || 'Failed to schedule notification' });
  }
});

function scheduledNotificationResponse(document) {
  const data = document.data() || {};
  return {
    id: document.id,
    title: data.title || '',
    body: data.body || '',
    target: data.target,
    imageUrl: data.imageUrl || null,
    actionUrl: data.actionUrl || null,
    recipientUids: data.recipientUids || null,
    recipientNames: data.recipientNames || null,
    scheduledAt: data.scheduledAt?.toDate?.()?.toISOString() || null,
    status: data.status,
    attemptCount: data.attemptCount || 0,
    lastError: data.lastError || null,
    isRecurring: Boolean(data.isRecurring),
    recurringType: data.recurringType || null,
    createdAt: data.createdAt?.toDate?.()?.toISOString() || null
  };
}

// API 12: Active Scheduled Notifications (cursor paginated)
app.get('/api/notifications/scheduled', async (req, res) => {
  try {
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 25, 1), 100);
    const cursor = req.query.cursor
      ? decodeNotificationCursor(req.query.cursor, SCHEDULED_NOTIFICATIONS)
      : null;
    if (req.query.cursor && !cursor) {
      return res.status(400).json({ success: false, message: 'Invalid scheduled cursor' });
    }

    let query = db
      .collection(SCHEDULED_NOTIFICATIONS)
      .where('status', 'in', ['pending', 'processing'])
      .orderBy('scheduledAt', 'asc')
      .orderBy('__name__', 'asc');
    if (cursor) query = query.startAfter(cursor.timestamp, cursor.reference);

    const snapshot = await query.limit(limit + 1).get();
    const documents = snapshot.docs.slice(0, limit);
    const nextCursor = snapshot.size > limit && documents.length > 0
      ? encodeNotificationCursor(documents.at(-1), 'scheduledAt')
      : null;

    res.json({
      success: true,
      data: {
        notifications: documents.map(scheduledNotificationResponse),
        nextCursor,
        hasMore: Boolean(nextCursor)
      }
    });
  } catch (error) {
    console.error('Error fetching scheduled notifications:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// API 13: Cancel a Scheduled Notification
app.post('/api/notifications/cancel', async (req, res) => {
  try {
    const { notificationId } = req.body || {};
    if (!notificationId) {
      return res.status(400).json({ success: false, message: 'notificationId is required' });
    }

    const docRef = db.collection(SCHEDULED_NOTIFICATIONS).doc(notificationId);
    const doc = await docRef.get();

    if (!doc.exists) {
      return res.status(404).json({ success: false, message: 'Scheduled notification not found' });
    }

    const status = doc.data().status;
    if (status !== 'pending') {
      return res.status(400).json({
        success: false,
        message: `Cannot cancel notification with status '${status}'`
      });
    }

    try {
      await docRef.update({
        status: 'cancelled',
        cancelledAt: FieldValue.serverTimestamp()
      }, { lastUpdateTime: doc.updateTime });
    } catch (error) {
      if (isPreconditionFailure(error)) {
        return res.status(409).json({
          success: false,
          message: 'The scheduler started processing this notification before it could be cancelled'
        });
      }
      throw error;
    }

    res.json({ success: true, message: 'Scheduled notification cancelled successfully' });
  } catch (error) {
    console.error('Error cancelling scheduled notification:', error);
    res.status(500).json({ success: false, message: error.message || 'Failed to cancel notification' });
  }
});

// API 14: Delete Notifications (history or scheduled)
app.post('/api/notifications/delete', async (req, res) => {
  try {
    const { ids, collection } = req.body || {};

    if (!Array.isArray(ids) || ids.length === 0) {
      return res.status(400).json({ success: false, message: 'ids array is required' });
    }

    const allowed = [NOTIFICATION_LOGS, SCHEDULED_NOTIFICATIONS];
    if (!collection || !allowed.includes(collection)) {
      return res.status(400).json({
        success: false,
        message: "collection must be 'notification_logs' or 'scheduled_notifications'"
      });
    }

    let scheduledDocuments = null;
    if (collection === SCHEDULED_NOTIFICATIONS) {
      scheduledDocuments = await db.getAll(
        ...ids.map(id => db.collection(SCHEDULED_NOTIFICATIONS).doc(id))
      );
      const processingDocument = scheduledDocuments.find(
        document => document.exists && document.data()?.status === 'processing'
      );
      if (processingDocument) {
        return res.status(409).json({
          success: false,
          message: 'A notification currently being sent cannot be deleted'
        });
      }
    }

    // Firestore caps a write batch at 500 operations.
    const batches = [];
    let batch = db.batch();
    let count = 0;

    for (let index = 0; index < ids.length; index++) {
      const id = ids[index];
      const reference = db.collection(collection).doc(id);
      const document = scheduledDocuments?.[index];
      if (document?.exists && document.updateTime) {
        batch.delete(reference, { lastUpdateTime: document.updateTime });
      } else {
        batch.delete(reference);
      }
      count++;
      if (count % 500 === 0) {
        batches.push(batch);
        batch = db.batch();
      }
    }
    if (count % 500 !== 0) batches.push(batch);

    try {
      await Promise.all(batches.map(b => b.commit()));
    } catch (error) {
      if (collection === SCHEDULED_NOTIFICATIONS && isPreconditionFailure(error)) {
        return res.status(409).json({
          success: false,
          message: 'A schedule changed while it was being deleted; refresh and try again'
        });
      }
      throw error;
    }

    res.json({ success: true, message: `${ids.length} notification(s) deleted` });
  } catch (error) {
    console.error('Error deleting notifications:', error);
    res.status(500).json({ success: false, message: error.message || 'Failed to delete notifications' });
  }
});

function nextRecurringDate(current, recurringType) {
  const dhakaOffsetMs = 6 * 60 * 60 * 1000;
  const wallClock = new Date(current.getTime() + dhakaOffsetMs);
  const year = wallClock.getUTCFullYear();
  const month = wallClock.getUTCMonth();
  const day = wallClock.getUTCDate();
  const hour = wallClock.getUTCHours();
  const minute = wallClock.getUTCMinutes();
  const second = wallClock.getUTCSeconds();
  let nextWallClock;

  switch (recurringType) {
    case 'daily':
      nextWallClock = new Date(Date.UTC(year, month, day + 1, hour, minute, second));
      break;
    case 'weekly':
      nextWallClock = new Date(Date.UTC(year, month, day + 7, hour, minute, second));
      break;
    case 'monthly': {
      const targetMonthStart = new Date(Date.UTC(year, month + 1, 1));
      const targetYear = targetMonthStart.getUTCFullYear();
      const targetMonth = targetMonthStart.getUTCMonth();
      const lastDay = new Date(Date.UTC(targetYear, targetMonth + 1, 0)).getUTCDate();
      nextWallClock = new Date(Date.UTC(
        targetYear,
        targetMonth,
        Math.min(day, lastDay),
        hour,
        minute,
        second
      ));
      break;
    }
    default:
      return null;
  }

  return new Date(nextWallClock.getTime() - dhakaOffsetMs);
}

function isPreconditionFailure(error) {
  return error?.code === 9 ||
    error?.code === 'failed-precondition' ||
    /(?:FAILED_PRECONDITION|Firestore REST (?:409|412))/.test(error?.message || '');
}

async function claimScheduledNotification(document, now) {
  const data = document.data() || {};
  const scheduledAt = data.scheduledAt?.toDate?.();
  if (!(scheduledAt instanceof Date) || isNaN(scheduledAt.getTime())) return null;

  if (data.status === 'processing') {
    const leaseUntil = data.leaseUntil?.toDate?.();
    if (leaseUntil instanceof Date && leaseUntil > now) return null;
  } else if (data.status !== 'pending') {
    return null;
  }

  const target = notificationTarget(data.target);
  if (!target || !document.updateTime) return null;

  const attemptCount = (Number.isInteger(data.attemptCount) ? data.attemptCount : 0) + 1;
  const claimToken = crypto.randomUUID();
  const occurrenceScheduledAt = data.occurrenceScheduledAt?.toDate?.() || scheduledAt;

  try {
    await document.ref.update({
      status: 'processing',
      claimToken,
      leaseUntil: Timestamp.fromDate(new Date(now.getTime() + SCHEDULER_LEASE_MS)),
      lastAttemptAt: FieldValue.serverTimestamp(),
      attemptCount,
      occurrenceScheduledAt: Timestamp.fromDate(occurrenceScheduledAt)
    }, { lastUpdateTime: document.updateTime });
  } catch (error) {
    if (isPreconditionFailure(error)) return null;
    throw error;
  }

  return {
    ...data,
    target,
    scheduledAt,
    occurrenceScheduledAt,
    attemptCount,
    maxAttempts: Number.isInteger(data.maxAttempts) ? data.maxAttempts : SCHEDULER_MAX_ATTEMPTS,
    claimToken
  };
}

async function finalizeClaim(documentReference, claimToken, updates) {
  const current = await documentReference.get();
  if (!current.exists || current.data()?.claimToken !== claimToken || !current.updateTime) return false;
  try {
    await current.ref.update(updates, { lastUpdateTime: current.updateTime });
    return true;
  } catch (error) {
    if (isPreconditionFailure(error)) return false;
    throw error;
  }
}

// Atomically claims each due occurrence before delivery. A retry keeps the
// original occurrence ID, allowing the mobile client to ignore a duplicate if
// a Worker stops after FCM accepts the message but before Firestore is updated.
async function processDueScheduledNotifications() {
  const now = new Date();
  const snapshot = await db
    .collection(SCHEDULED_NOTIFICATIONS)
    .where('status', 'in', ['pending', 'processing'])
    .where('scheduledAt', '<=', Timestamp.fromDate(now))
    .orderBy('scheduledAt', 'asc')
    .limit(SCHEDULER_BATCH_LIMIT)
    .get();

  const dueDocs = snapshot.docs;
  if (dueDocs.length === 0) return { processed: 0, sent: 0, failed: 0 };

  let sent = 0;
  let failed = 0;

  for (const doc of dueDocs) {
    const data = await claimScheduledNotification(doc, now);
    if (!data) continue;

    const target = data.target;
    const recipientUids = target === 'selected_users' ? selectedEmployeeIds(data) : [];
    const occurrenceId = `scheduled:${doc.id}:${data.occurrenceScheduledAt.toISOString()}`;

    let status = 'success';
    let sendError = null;
    let successCount = 0;
    let failureCount = 0;
    let deliveryMode = target === 'office_broadcast' ? 'topic' : 'tokens';
    let skippedReason = null;

    try {
      const result = await deliverNotification({
        target,
        title: data.title || '',
        body: data.body || '',
        imageUrl: data.imageUrl || '',
        actionUrl: data.actionUrl || '',
        recipientUids,
        occurrenceAt: data.occurrenceScheduledAt,
        occurrenceId
      });
      successCount = result.successCount;
      failureCount = result.failureCount;
      deliveryMode = result.deliveryMode;
      skippedReason = result.skippedReason || null;
    } catch (error) {
      console.error(`Failed to send scheduled notification ${doc.id}:`, error);
      status = 'failed';
      sendError = error.message || 'Unknown error';
      failureCount = error.failureCount || 1;
    }

    const willRetry = status === 'failed' && data.attemptCount < data.maxAttempts;
    if (status === 'success' || !willRetry) {
      try {
        await writeNotificationLog({
          target,
          title: data.title || '',
          body: data.body || '',
          imageUrl: data.imageUrl || null,
          actionUrl: data.actionUrl || null,
          recipientUids: target === 'selected_users' ? recipientUids : null,
          recipientNames: data.recipientNames || null,
          status,
          error: sendError,
          successCount,
          failureCount,
          deliveryMode,
          skippedReason,
          occurrenceId,
          scheduledNotificationId: doc.id,
          source: 'scheduler'
        });
      } catch (logError) {
        console.error('Could not log scheduled notification:', logError);
      }
    }

    try {
      if (status === 'success' && data.isRecurring) {
        const nextDate = nextRecurringDate(data.occurrenceScheduledAt, data.recurringType);
        if (!nextDate) throw new Error('Invalid recurring notification type');
        await finalizeClaim(doc.ref, data.claimToken, {
          status: 'pending',
          scheduledAt: Timestamp.fromDate(nextDate),
          occurrenceScheduledAt: Timestamp.fromDate(nextDate),
          attemptCount: 0,
          claimToken: null,
          leaseUntil: null,
          lastError: null,
          processedAt: FieldValue.serverTimestamp()
        });
      } else if (status === 'success') {
        await finalizeClaim(doc.ref, data.claimToken, {
          status: 'sent',
          claimToken: null,
          leaseUntil: null,
          lastError: null,
          processedAt: FieldValue.serverTimestamp()
        });
      } else if (willRetry) {
        const retryDelay = SCHEDULER_RETRY_DELAYS_MS[
          Math.min(data.attemptCount - 1, SCHEDULER_RETRY_DELAYS_MS.length - 1)
        ];
        await finalizeClaim(doc.ref, data.claimToken, {
          status: 'pending',
          scheduledAt: Timestamp.fromDate(new Date(Date.now() + retryDelay)),
          claimToken: null,
          leaseUntil: null,
          lastError: sendError
        });
      } else {
        await finalizeClaim(doc.ref, data.claimToken, {
          status: 'failed',
          claimToken: null,
          leaseUntil: null,
          lastError: sendError,
          processedAt: FieldValue.serverTimestamp()
        });
      }
    } catch (updateError) {
      console.error('Could not finalize scheduled notification:', updateError);
    }

    if (status === 'success') sent++;
    else failed++;
  }

  return { processed: sent + failed, sent, failed };
}

// API 15: Run Due Scheduled Notifications (manual trigger)
app.post('/api/notifications/run-scheduled', async (req, res) => {
  try {
    const result = await processDueScheduledNotifications();
    const message = result.processed === 0
      ? 'No due notifications'
      : `Processed ${result.processed} notification(s): ${result.sent} sent, ${result.failed} failed`;
    res.json({ success: true, message, data: result });
  } catch (error) {
    console.error('Error running scheduled notifications:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// One run at a time — a slow FCM batch must not overlap with the next tick and
// send the same notification twice.
let isProcessingScheduled = false;
async function scheduledNotificationTick() {
  if (isProcessingScheduled) return;
  isProcessingScheduled = true;
  try {
    const result = await processDueScheduledNotifications();
    if (result.processed > 0) {
      console.log(`Scheduled notifications: ${result.sent} sent, ${result.failed} failed`);
    }
  } catch (error) {
    console.error('Scheduled notification tick failed:', error);
  } finally {
    isProcessingScheduled = false;
  }
}

// Keep local Node.js development consistent with the Cloudflare SPA fallback.
// API routes and real static assets are resolved first; only known dashboard
// views receive index.html so a direct deep-link or browser refresh still works.
if (!isCloudflareWorker) {
  app.get(
    /^\/(?:overview|attendance|employees(?:\/(?:new|[^/]+))?|notifications|settings)\/?$/,
    (_req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html'))
  );
}

app.listen(PORT, () => {
  console.log(`Sarah Time Admin Dashboard running on http://localhost:${PORT}`);
  if (!isCloudflareWorker) {
    scheduledNotificationTick();
    setInterval(scheduledNotificationTick, SCHEDULER_TICK_MS);
  }
});

module.exports = {
  app,
  ensureFirebaseInitialized,
  loadOfficePolicy,
  loadDateOverrides,
  processDueScheduledNotifications
};
