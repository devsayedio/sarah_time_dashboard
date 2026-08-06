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

    const absentCount = Math.max(0, activeEmployees - checkedInCount);

    // Fetch Office Settings
    const policySnap = await db.collection('settings').doc('office').get();
    const officeSettings = policySnap.exists ? policySnap.data() : null;

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
        absentCount
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
      }

      employees.push({
        id: empId,
        authEmail: empData.authEmail || profile.officialEmail || 'N/A',
        employeeCode: empData.employeeId || profile.employeeId || empId,
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
    const {
      employeeName, phoneNumber, personalEmail, nidOrPassport, presentAddress, permanentAddress,
      employeeId, designation, department, employmentType, officialEmail, salary,
      emergencyContactName, emergencyContactNumber, emergencyContactRelationship, bankAccount
    } = req.body;
    
    const emailToUse = officialEmail || personalEmail;
    if (!emailToUse) {
      return res.status(400).json({ success: false, error: "An official or personal email is required to create an account." });
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

    const profileData = {
      employeeName, phoneNumber, personalEmail, nidOrPassport, presentAddress, permanentAddress,
      employeeId, designation, department, employmentType, officialEmail, salary,
      emergencyContactName, emergencyContactNumber, emergencyContactRelationship, bankAccount,
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp()
    };
    
    // Remove undefined values
    Object.keys(profileData).forEach(key => profileData[key] === undefined && delete profileData[key]);

    // Create main employee doc
    const mainEmpData = {
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
      authEmail: emailToUse
    };
    if (employeeId) mainEmpData.employeeCode = employeeId;
    
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
    const {
      employeeName, phoneNumber, personalEmail, nidOrPassport, presentAddress, permanentAddress,
      employeeId, designation, department, employmentType, officialEmail, salary,
      emergencyContactName, emergencyContactNumber, emergencyContactRelationship, bankAccount
    } = req.body;

    const profileData = {
      employeeName, phoneNumber, personalEmail, nidOrPassport, presentAddress, permanentAddress,
      employeeId, designation, department, employmentType, officialEmail, salary,
      emergencyContactName, emergencyContactNumber, emergencyContactRelationship, bankAccount,
      updatedAt: FieldValue.serverTimestamp()
    };
    
    // Remove undefined values to avoid overwriting with undefined
    Object.keys(profileData).forEach(key => profileData[key] === undefined && delete profileData[key]);

    // Update main employee doc
    const mainEmpData = {
      updatedAt: FieldValue.serverTimestamp()
    };
    if (employeeId) mainEmpData.employeeId = employeeId;
    if (officialEmail) mainEmpData.authEmail = officialEmail;
    
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

// API 4: Attendance History Log
app.get('/api/attendance', async (req, res) => {
  try {
    const targetDate = req.query.date || getDhakaDateKey();
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
          employeeCode: profile.employeeId || empData.employeeId || empId,
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
            employeeCode: profile.employeeId || empData.employeeId || empId,
            designation: profile.designation || 'N/A',
            department: profile.department || 'N/A',
            dateKey: targetDate,
            status: 'absent',
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
