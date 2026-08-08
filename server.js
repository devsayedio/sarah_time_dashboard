const express = require('express');
const cors = require('cors');
const path = require('path');
const { initializeApp, cert } = require('firebase-admin/app');
const { getFirestore, FieldValue, Timestamp } = require('firebase-admin/firestore');
const { getMessaging } = require('firebase-admin/messaging');

// Initialize Firebase Admin SDK using local service account
const serviceAccount = require('./service-account.json');

initializeApp({
  credential: cert(serviceAccount),
  projectId: 'employee-attendance-30f81'
});

const db = getFirestore();
const app = express();
const PORT = process.env.PORT || 3000;
const EMPLOYEES = 'employees';
const ATTENDANCE = 'attendance';

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
app.use(express.static(path.join(__dirname, 'public')));

// Deployment health probe. The CI pipeline polls this after restarting PM2 and
// fails the run if it never turns healthy, so keep it free of Firestore calls.
app.get('/healthz', (req, res) => {
  res.json({ status: 'ok', uptime: process.uptime() });
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

function attendanceForDashboard(data) {
  if (!data) return null;
  return {
    ...data,
    checkInFormatted: formatTimestamp(data.checkInAt),
    checkOutFormatted: formatTimestamp(data.checkOutAt)
  };
}

function attendanceLog(employeeId, employeeData, dateKey, attendance, holidayInfo) {
  const isActive = employeeData.isActive !== false;
  if (!attendance && !isActive) return null;

  return {
    id: employeeId,
    employeeName: employeeData.employeeName || employeeData.authEmail || 'Unknown',
    employeeCode: employeeData.employeeId || employeeData.employeeCode || employeeId,
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
      employeeCode: employeeData.employeeCode || employeeData.employeeId || doc.id,
      isActive,
      hasFcmToken: Boolean(employeeData.fcmToken),
      profile: employeeProfile(employeeData),
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
        employeeCode: empData.employeeCode || empData.employeeId || empId,
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
    const { employeeName, personalEmail, employeeId, joiningDate } = req.body;

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
      authEmail: emailToUse,
      employeeCode: toProfileString(employeeId)
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
    const { employeeId, joiningDate } = req.body;

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
    if (employeeId) mainEmpData.employeeCode = String(employeeId);

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
      return require('firebase-admin/firestore').Timestamp.fromDate(dateObj);
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

// API 5: Office Settings & Date Overrides
app.get('/api/settings/office', async (req, res) => {
  try {
    const officeDoc = await db.collection('settings').doc('office').get();
    const settings = officeDoc.exists ? officeDoc.data() : null;

    const overridesSnap = await db
      .collection('settings')
      .doc('office')
      .collection('date_overrides')
      .get();

    const dateOverrides = [];
    overridesSnap.forEach(doc => {
      dateOverrides.push({ dateKey: doc.id, ...doc.data() });
    });

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
//
// Ported from the Text Bee dashboard (`server/src/send-notification.js` and
// `functions/index.js` Module 7). Same Firestore collections
// (`notification_logs`, `scheduled_notifications`), same document fields and
// the same request/response contract.
//
// One deliberate deviation: Text Bee publishes to the `all_users` FCM topic,
// but the Sarah Time app never subscribes to a topic — it writes its
// registration token to `employees/{uid}.fcmToken`
// (backend_as_a_service.dart). So "all employees" is a token multicast over
// every active employee instead of a topic publish.
// ═══════════════════════════════════════════════════════════════════════

const NOTIFICATION_LOGS = 'notification_logs';
const SCHEDULED_NOTIFICATIONS = 'scheduled_notifications';
const MAX_SELECTED_RECIPIENTS = 500;
const FCM_MULTICAST_CHUNK = 500;
const SCHEDULER_TICK_MS = 5 * 60 * 1000;
const SCHEDULER_BATCH_LIMIT = 100;

function optionalString(value, maxLength) {
  if (typeof value !== 'string') return '';
  return value.trim().slice(0, maxLength);
}

// Text Bee accepts three spellings of the single-recipient target; keep them
// working so a payload copied from that dashboard still resolves correctly.
function normalizeTarget(target) {
  return ['selected_users', 'single_user', 'single'].includes(target)
    ? 'selected_users'
    : 'all_users';
}

function selectedEmployeeIds(source) {
  const rawIds = Array.isArray(source.recipientUids)
    ? source.recipientUids
    : source.recipientUid
      ? [source.recipientUid]
      : [];

  return [...new Set(rawIds)]
    .filter(uid => typeof uid === 'string' && uid.trim().length > 0)
    .map(uid => uid.trim())
    .slice(0, MAX_SELECTED_RECIPIENTS);
}

function buildFcmPayload({ title, body, imageUrl, actionUrl }) {
  const notification = { title, body };
  if (imageUrl) notification.imageUrl = imageUrl;

  const data = { type: 'push' };
  if (imageUrl) data.imageUrl = imageUrl;
  if (actionUrl) data.actionUrl = actionUrl;

  return { notification, data };
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

async function sendToTokens(tokens, notification, data) {
  let successCount = 0;
  let failureCount = 0;

  for (let index = 0; index < tokens.length; index += FCM_MULTICAST_CHUNK) {
    const chunk = tokens.slice(index, index + FCM_MULTICAST_CHUNK);
    const result = await getMessaging().sendEachForMulticast({
      notification,
      data,
      tokens: chunk
    });
    successCount += result.successCount;
    failureCount += result.failureCount;
  }

  return { successCount, failureCount };
}

// Shared by the immediate send endpoint and the scheduled-notification runner.
// Throws with `code = 'no_recipients'` when nobody could be reached, matching
// Text Bee's "No users could be reached" behaviour.
async function deliverNotification({ target, title, body, imageUrl, actionUrl, recipientUids }) {
  const { notification, data } = buildFcmPayload({ title, body, imageUrl, actionUrl });
  const resolved = await resolveRecipients(target, recipientUids);

  if (resolved.tokens.length === 0) {
    const error = new Error('No employees could be reached');
    error.code = 'no_recipients';
    error.recipientNames = resolved.recipientNames;
    error.failureCount = Math.max(resolved.failureCount, 1);
    throw error;
  }

  const sendResult = await sendToTokens(resolved.tokens, notification, data);

  return {
    successCount: sendResult.successCount,
    failureCount: resolved.failureCount + sendResult.failureCount,
    recipientNames: resolved.recipientNames
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

  const target = normalizeTarget(payload.target);
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
      source: 'dashboard'
    });

    const message = `Notification sent to ${result.successCount} employee(s)` +
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
          : 'No active employee has registered a device yet'
      });
    }

    res.status(500).json({ success: false, message: error.message || 'Failed to send notification' });
  }
});

// API 10: Notification History (paginated + filtered)
app.get('/api/notifications/history', async (req, res) => {
  try {
    const page = parseInt(req.query.page, 10) || 1;
    const limit = Math.min(parseInt(req.query.limit, 10) || 50, 100);
    const targetFilter = (req.query.target || '').trim();
    const statusFilter = (req.query.status || '').trim();
    const search = (req.query.search || '').trim().toLowerCase();
    const dateFrom = (req.query.dateFrom || '').trim();
    const dateTo = (req.query.dateTo || '').trim();

    const snapshot = await db.collection(NOTIFICATION_LOGS).orderBy('timestamp', 'desc').get();

    let logs = snapshot.docs.map(doc => {
      const data = doc.data();
      return {
        id: doc.id,
        target: data.target || 'all_users',
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
        scheduledNotificationId: data.scheduledNotificationId || null,
        timestamp: data.timestamp?.toDate?.()?.toISOString() || null
      };
    });

    if (targetFilter && ['all_users', 'selected_users', 'single_user'].includes(targetFilter)) {
      const normalized = normalizeTarget(targetFilter);
      logs = logs.filter(log => normalizeTarget(log.target) === normalized);
    }
    if (statusFilter && ['success', 'failed'].includes(statusFilter)) {
      logs = logs.filter(log => log.status === statusFilter);
    }
    if (search) {
      logs = logs.filter(log =>
        log.title.toLowerCase().includes(search) ||
        log.body.toLowerCase().includes(search) ||
        (log.recipientNames || []).some(name => String(name).toLowerCase().includes(search))
      );
    }
    // Both bounds are inclusive Dhaka calendar days, like every other date
    // filter in this dashboard.
    if (dateFrom) {
      const from = toDhakaDate(`${dateFrom.slice(0, 10)}T00:00`);
      if (from) logs = logs.filter(log => log.timestamp && new Date(log.timestamp) >= from);
    }
    if (dateTo) {
      const to = toDhakaDate(`${dateTo.slice(0, 10)}T23:59:59`);
      if (to) logs = logs.filter(log => log.timestamp && new Date(log.timestamp) <= to);
    }

    const totalCount = logs.length;
    const startIndex = (page - 1) * limit;

    res.json({
      success: true,
      data: {
        logs: logs.slice(startIndex, startIndex + limit),
        totalCount,
        page,
        limit,
        hasMore: startIndex + limit < totalCount
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

    const target = normalizeTarget(payload.target);
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
      isRecurring,
      recurringType: isRecurring ? recurringType : null,
      createdAt: FieldValue.serverTimestamp()
    });

    const audience = target === 'selected_users'
      ? `${recipientUids.length} employee(s)`
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

// API 12: Scheduled Notifications List
app.get('/api/notifications/scheduled', async (req, res) => {
  try {
    const snapshot = await db.collection(SCHEDULED_NOTIFICATIONS).orderBy('scheduledAt', 'asc').get();

    const notifications = snapshot.docs.map(doc => {
      const data = doc.data();
      return {
        id: doc.id,
        title: data.title || '',
        body: data.body || '',
        target: data.target || 'all_users',
        imageUrl: data.imageUrl || null,
        actionUrl: data.actionUrl || null,
        recipientUids: data.recipientUids || null,
        recipientNames: data.recipientNames || null,
        scheduledAt: data.scheduledAt?.toDate?.()?.toISOString() || null,
        status: data.status || 'pending',
        isRecurring: data.isRecurring || false,
        recurringType: data.recurringType || null,
        createdAt: data.createdAt?.toDate?.()?.toISOString() || null
      };
    });

    res.json({ success: true, data: notifications });
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

    await docRef.update({
      status: 'cancelled',
      cancelledAt: FieldValue.serverTimestamp()
    });

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

    // Firestore caps a write batch at 500 operations.
    const batches = [];
    let batch = db.batch();
    let count = 0;

    for (const id of ids) {
      batch.delete(db.collection(collection).doc(id));
      count++;
      if (count % 500 === 0) {
        batches.push(batch);
        batch = db.batch();
      }
    }
    if (count % 500 !== 0) batches.push(batch);

    await Promise.all(batches.map(b => b.commit()));

    res.json({ success: true, message: `${ids.length} notification(s) deleted` });
  } catch (error) {
    console.error('Error deleting notifications:', error);
    res.status(500).json({ success: false, message: error.message || 'Failed to delete notifications' });
  }
});

function nextRecurringDate(current, recurringType) {
  const next = new Date(current);
  switch (recurringType) {
    case 'daily':
      next.setDate(next.getDate() + 1);
      return next;
    case 'weekly':
      next.setDate(next.getDate() + 7);
      return next;
    case 'monthly':
      next.setMonth(next.getMonth() + 1);
      return next;
    default:
      return null;
  }
}

// Sends every pending scheduled notification whose time has come, logs the
// outcome to `notification_logs`, and queues the next occurrence of a
// recurring one. Text Bee runs this from Cloud Scheduler; this dashboard is a
// long-running Express process, so it runs on an in-process interval and is
// also exposed as an endpoint for manual runs.
async function processDueScheduledNotifications() {
  const snapshot = await db
    .collection(SCHEDULED_NOTIFICATIONS)
    .where('status', '==', 'pending')
    .where('scheduledAt', '<=', Timestamp.fromDate(new Date()))
    .orderBy('scheduledAt', 'asc')
    .limit(SCHEDULER_BATCH_LIMIT)
    .get();

  const dueDocs = snapshot.docs;
  if (dueDocs.length === 0) return { processed: 0, sent: 0, failed: 0 };

  let sent = 0;
  let failed = 0;

  for (const doc of dueDocs) {
    const data = doc.data();
    const target = normalizeTarget(data.target);
    const recipientUids = target === 'selected_users' ? selectedEmployeeIds(data) : [];

    let status = 'success';
    let sendError = null;
    let successCount = 0;
    let failureCount = 0;

    try {
      const result = await deliverNotification({
        target,
        title: data.title || '',
        body: data.body || '',
        imageUrl: data.imageUrl || '',
        actionUrl: data.actionUrl || '',
        recipientUids
      });
      successCount = result.successCount;
      failureCount = result.failureCount;
    } catch (error) {
      console.error(`Failed to send scheduled notification ${doc.id}:`, error);
      status = 'failed';
      sendError = error.message || 'Unknown error';
      failureCount = error.failureCount || 1;
    }

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
        scheduledNotificationId: doc.id,
        source: 'scheduler'
      });
    } catch (logError) {
      console.error('Could not log scheduled notification:', logError);
    }

    try {
      await doc.ref.update({
        status: status === 'success' ? 'sent' : 'failed',
        processedAt: FieldValue.serverTimestamp()
      });
    } catch (updateError) {
      console.error('Could not update scheduled notification status:', updateError);
    }

    if (data.isRecurring && status === 'success') {
      try {
        const currentScheduled = data.scheduledAt.toDate();
        const nextDate = nextRecurringDate(currentScheduled, data.recurringType);

        if (nextDate) {
          await db.collection(SCHEDULED_NOTIFICATIONS).add({
            target,
            title: data.title || '',
            body: data.body || '',
            imageUrl: data.imageUrl || null,
            actionUrl: data.actionUrl || null,
            recipientUids: target === 'selected_users' ? recipientUids : null,
            recipientNames: data.recipientNames || null,
            scheduledAt: Timestamp.fromDate(nextDate),
            status: 'pending',
            isRecurring: true,
            recurringType: data.recurringType,
            createdAt: FieldValue.serverTimestamp(),
            parentNotificationId: doc.id
          });
          console.log(`Recurring notification ${doc.id}: next occurrence at ${nextDate.toISOString()}`);
        }
      } catch (recurringError) {
        console.error('Could not queue next recurring notification:', recurringError);
      }
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

app.listen(PORT, () => {
  console.log(`Sarah Time Admin Dashboard running on http://localhost:${PORT}`);
  scheduledNotificationTick();
  setInterval(scheduledNotificationTick, SCHEDULER_TICK_MS);
});
