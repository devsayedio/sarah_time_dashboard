const express = require('express');
const cors = require('cors');
const path = require('path');
const { initializeApp, cert } = require('firebase-admin/app');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');

// Initialize Firebase Admin SDK using local service account
const serviceAccount = require('./service-account.json');

initializeApp({
  credential: cert(serviceAccount),
  projectId: 'employee-attendance-30f81'
});

const db = getFirestore();
const app = express();
const PORT = process.env.PORT || 3000;

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

// API 1: Overview Statistics
app.get('/api/stats', async (req, res) => {
  try {
    const dateKey = req.query.date || getDhakaDateKey();
    
    // Fetch Employees
    const employeesSnap = await db.collection('employees').get();
    let totalEmployees = 0;
    let activeEmployees = 0;
    const employeeList = [];

    employeesSnap.forEach(doc => {
      const data = doc.data();
      totalEmployees++;
      if (data.isActive !== false) activeEmployees++;
      employeeList.push({ id: doc.id, ...data });
    });

    // Fetch Attendance for target date for all active employees
    let presentCount = 0;
    let lateCount = 0;
    let checkedOutCount = 0;
    let checkedInCount = 0;

    for (const emp of employeeList) {
      const attSnap = await db
        .collection('employees')
        .doc(emp.id)
        .collection('attendance_history')
        .doc(dateKey)
        .get();

      if (attSnap.exists) {
        const att = attSnap.data();
        checkedInCount++;
        if (att.status === 'present') presentCount++;
        if (att.status === 'late') lateCount++;
        if (att.checkOutAt) checkedOutCount++;
      }
    }

    // Fetch Office Settings
    const policySnap = await db.collection('settings').doc('office').get();
    const officeSettings = policySnap.exists ? policySnap.data() : null;

    const overridesSnap = await db.collection('settings').doc('office').collection('date_overrides').get();
    const dateOverrides = [];
    overridesSnap.forEach(doc => dateOverrides.push({ dateKey: doc.id, ...doc.data() }));

    const holidayInfo = getHolidayStatus(dateKey, officeSettings, dateOverrides);
    let absentCount = Math.max(0, activeEmployees - checkedInCount);
    
    if (holidayInfo.isHoliday) {
      absentCount = 0;
    }

    res.json({
      success: true,
      dateKey,
      stats: {
        totalEmployees,
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
        attendanceEnabled: !holidayInfo.isHoliday,
        notice: holidayInfo.notice
      },
      officeSettings
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
    
    const policySnap = await db.collection('settings').doc('office').get();
    const officeSettings = policySnap.exists ? policySnap.data() : null;
    const overridesSnap = await db.collection('settings').doc('office').collection('date_overrides').get();
    const dateOverrides = [];
    overridesSnap.forEach(doc => dateOverrides.push({ dateKey: doc.id, ...doc.data() }));
    const holidayInfo = getHolidayStatus(dateKey, officeSettings, dateOverrides);

    const employeesSnap = await db.collection('employees').get();
    const employees = [];

    for (const empDoc of employeesSnap.docs) {
      const empData = empDoc.data();
      const empId = empDoc.id;

      const profileSnap = await db
        .collection('employees')
        .doc(empId)
        .collection('profile')
        .doc('details')
        .get();

      const profile = profileSnap.exists ? profileSnap.data() : {};
      // Timestamps serialize as {_seconds,...}; the form needs a date input value.
      profile.joiningDate = toDateInputValue(profile.joiningDate);

      const attSnap = await db
        .collection('employees')
        .doc(empId)
        .collection('attendance_history')
        .doc(dateKey)
        .get();

      let attendance = null;
      if (attSnap.exists) {
        const aData = attSnap.data();
        attendance = {
          ...aData,
          checkInFormatted: formatTimestamp(aData.checkInAt),
          checkOutFormatted: formatTimestamp(aData.checkOutAt)
        };
      } else if (holidayInfo.isHoliday && empData.isActive !== false) {
        attendance = {
          status: holidayInfo.statusText,
          checkInFormatted: '-',
          checkOutFormatted: '-'
        };
      }

      employees.push({
        id: empId,
        authEmail: empData.authEmail || profile.personalEmail || 'N/A',
        employeeCode: empData.employeeCode || profile.employeeId || empId,
        isActive: empData.isActive !== false,
        fcmToken: empData.fcmToken || null,
        profile,
        todayAttendance: attendance
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

    // Create main employee doc. `isActive` is required by the app and by the
    // markAttendance cloud function, so a new employee must start active.
    const mainEmpData = {
      isActive: true,
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
      authEmail: emailToUse,
      employeeCode: toProfileString(employeeId)
    };

    await db.collection('employees').doc(uid).set(mainEmpData);

    // Create profile doc
    await db.collection('employees').doc(uid).collection('profile').doc('details').set(profileData);

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

    const profileSnap = await db
      .collection('employees')
      .doc(id)
      .collection('profile')
      .doc('details')
      .get();
    const existingProfile = profileSnap.exists ? profileSnap.data() : {};

    const profileData = {
      schemaVersion: 1,
      updatedAt: FieldValue.serverTimestamp()
    };
    // Only send fields the client actually submitted; fall back to what is
    // already stored so an incomplete form can never strip a required field.
    for (const field of PROFILE_STRING_FIELDS) {
      const submitted = req.body[field];
      profileData[field] = submitted === undefined
        ? toProfileString(existingProfile[field])
        : toProfileString(submitted);
    }
    if (!profileData.profileImagePath) {
      profileData.profileImagePath = DEFAULT_PROFILE_IMAGE_PATH;
    }
    if (joiningDate || existingProfile.joiningDate === undefined) {
      profileData.joiningDate = toJoiningTimestamp(joiningDate);
    }

    // Update main employee doc. `authEmail` mirrors the Firebase Auth login
    // email, so it must never be replaced by the official (work) email here.
    const mainEmpData = {
      updatedAt: FieldValue.serverTimestamp()
    };
    if (employeeId) mainEmpData.employeeCode = String(employeeId);

    // Repair documents created before `isActive` was written.
    const empSnap = await db.collection('employees').doc(id).get();
    if (typeof empSnap.data()?.isActive !== 'boolean') {
      mainEmpData.isActive = true;
    }

    await db.collection('employees').doc(id).set(mainEmpData, { merge: true });

    // Update profile doc
    await db.collection('employees').doc(id).collection('profile').doc('details').set(profileData, { merge: true });

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
    
    // In a real production app, recursive delete is better handled by a Cloud Function or admin SDK's recursiveDelete
    await db.recursiveDelete(db.collection('employees').doc(id));
    
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

    const attendanceSnap = await db.collection('employees').doc(id).collection('attendance_history')
      .where(require('firebase-admin/firestore').FieldPath.documentId(), '>=', startKey)
      .where(require('firebase-admin/firestore').FieldPath.documentId(), '<=', endKey)
      .get();

    const records = [];
    attendanceSnap.forEach(doc => {
      const data = doc.data();
      records.push({
        dateKey: doc.id,
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
    
    const policySnap = await db.collection('settings').doc('office').get();
    const officeSettings = policySnap.exists ? policySnap.data() : null;
    const overridesSnap = await db.collection('settings').doc('office').collection('date_overrides').get();
    const dateOverrides = [];
    overridesSnap.forEach(doc => dateOverrides.push({ dateKey: doc.id, ...doc.data() }));
    const holidayInfo = getHolidayStatus(targetDate, officeSettings, dateOverrides);

    const employeesSnap = await db.collection('employees').get();
    const attendanceLogs = [];

    for (const empDoc of employeesSnap.docs) {
      const empData = empDoc.data();
      const empId = empDoc.id;

      const profileSnap = await db
        .collection('employees')
        .doc(empId)
        .collection('profile')
        .doc('details')
        .get();

      const profile = profileSnap.exists ? profileSnap.data() : {};

      const attSnap = await db
        .collection('employees')
        .doc(empId)
        .collection('attendance_history')
        .doc(targetDate)
        .get();

      if (attSnap.exists) {
        const att = attSnap.data();
        attendanceLogs.push({
          id: empId,
          employeeName: profile.employeeName || empData.authEmail || 'Unknown',
          employeeCode: profile.employeeId || empData.employeeCode || empId,
          designation: profile.designation || 'N/A',
          department: profile.department || 'N/A',
          dateKey: targetDate,
          status: att.status || 'present',
          lateByMinutes: att.lateByMinutes || 0,
          checkInAt: att.checkInAt ? formatTimestamp(att.checkInAt) : 'N/A',
          checkOutAt: att.checkOutAt ? formatTimestamp(att.checkOutAt) : 'Pending',
          checkInLocation: att.checkInLocation || null,
          checkOutLocation: att.checkOutLocation || null
        });
      } else {
        if (empData.isActive !== false) {
          attendanceLogs.push({
            id: empId,
            employeeName: profile.employeeName || empData.authEmail || 'Unknown',
            employeeCode: profile.employeeId || empData.employeeCode || empId,
            designation: profile.designation || 'N/A',
            department: profile.department || 'N/A',
            dateKey: targetDate,
            status: holidayInfo.isHoliday ? holidayInfo.statusText : 'absent',
            lateByMinutes: 0,
            checkInAt: '-',
            checkOutAt: '-',
            checkInLocation: null,
            checkOutLocation: null
          });
        }
      }
    }

    res.json({ success: true, date: targetDate, logs: attendanceLogs });
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
      .collection('employees')
      .doc(employeeId)
      .collection('attendance_history')
      .doc(dateKey);

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
      .collection('employees')
      .doc(employeeId)
      .collection('attendance_history')
      .doc(dateKey)
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

    await db.collection('settings').doc('office').set(updateData, { merge: true });
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

app.listen(PORT, () => {
  console.log(`Sarah Time Admin Dashboard running on http://localhost:${PORT}`);
});
