"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = __importDefault(require("express"));
const cors_1 = __importDefault(require("cors"));
const client_1 = require("@prisma/client");
const pg_1 = require("pg");
const adapter_pg_1 = require("@prisma/adapter-pg");
const bcryptjs_1 = __importDefault(require("bcryptjs"));
const jsonwebtoken_1 = __importDefault(require("jsonwebtoken"));
require("dotenv/config");
const connectionString = process.env.DATABASE_URL;
const JWT_SECRET = process.env.JWT_SECRET;
const PORT = Number(process.env.PORT || 5000);
if (!connectionString) {
    throw new Error("DATABASE_URL is missing");
}
if (!JWT_SECRET) {
    throw new Error("JWT_SECRET is missing");
}
const pool = new pg_1.Pool({
    connectionString,
    max: 10,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 10000,
});
const adapter = new adapter_pg_1.PrismaPg(pool);
const prisma = new client_1.PrismaClient({ adapter });
const app = (0, express_1.default)();
const parseGradePeriod = (value) => {
    if (value === 'TRIMESTER_2')
        return 'TRIMESTER_2';
    if (value === 'TRIMESTER_3')
        return 'TRIMESTER_3';
    return 'TRIMESTER_1';
};
app.use((0, cors_1.default)());
app.use(express_1.default.json());
const authenticateToken = (req, res, next) => {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];
    if (!token)
        return res.status(401).json({ error: "Access denied!" });
    jsonwebtoken_1.default.verify(token, JWT_SECRET, (err, user) => {
        if (err)
            return res.status(403).json({ error: "Invalid token!" });
        req.user = user;
        next();
    });
};
const isAdminOrTeacher = (req) => {
    const role = req.user?.role;
    return role === 'ADMIN' || role === 'TEACHER';
};
const parseAssignmentStatus = (value) => {
    const normalized = (value || 'PENDING').toUpperCase();
    return normalized === 'DONE' ? 'DONE' : 'PENDING';
};
const parseAnnouncementAudience = (value) => {
    if (value === 'STUDENTS')
        return 'STUDENTS';
    if (value === 'PARENTS')
        return 'PARENTS';
    if (value === 'TEACHERS')
        return 'TEACHERS';
    if (value === 'CLASS')
        return 'CLASS';
    return 'ALL';
};
const getAllowedAnnouncementAudiences = (role) => {
    if (role === "ADMIN") {
        return [
            client_1.AnnouncementAudience.ALL,
            client_1.AnnouncementAudience.STUDENTS,
            client_1.AnnouncementAudience.PARENTS,
            client_1.AnnouncementAudience.TEACHERS,
            client_1.AnnouncementAudience.CLASS,
        ];
    }
    if (role === "TEACHER") {
        return [
            client_1.AnnouncementAudience.TEACHERS,
            client_1.AnnouncementAudience.CLASS,
        ];
    }
    return [];
};
const createNotificationsForUserIds = async (userIds, title, message, type, relatedId) => {
    const uniqueUserIds = [...new Set(userIds.filter(Boolean))];
    if (uniqueUserIds.length === 0)
        return;
    await prisma.notification.createMany({
        data: uniqueUserIds.map((userId) => ({
            userId,
            title,
            message,
            type,
            relatedId: relatedId || null,
        })),
    });
};
const messageUserSelect = {
    id: true,
    firstName: true,
    lastName: true,
    email: true,
    role: true,
};
const uniqueStringValues = (values) => {
    return [...new Set(values.filter(Boolean))];
};
const getAllowedMessageRecipients = async (userId, role) => {
    if (role === client_1.Role.ADMIN) {
        return prisma.user.findMany({
            where: {
                isActive: true,
                id: { not: userId },
            },
            select: messageUserSelect,
            orderBy: [
                { role: 'asc' },
                { firstName: 'asc' },
                { lastName: 'asc' },
            ],
        });
    }
    if (role === client_1.Role.TEACHER) {
        const teacher = await prisma.teacher.findUnique({
            where: { userId },
            include: {
                schedules: {
                    select: {
                        classId: true,
                    },
                },
            },
        });
        const classIds = uniqueStringValues((teacher?.schedules ?? []).map((schedule) => schedule.classId));
        return prisma.user.findMany({
            where: {
                isActive: true,
                id: { not: userId },
                OR: [
                    { role: client_1.Role.ADMIN },
                    { role: client_1.Role.TEACHER },
                    ...(classIds.length > 0
                        ? [
                            {
                                studentProfile: {
                                    is: {
                                        classId: {
                                            in: classIds,
                                        },
                                    },
                                },
                            },
                            {
                                parentProfile: {
                                    is: {
                                        children: {
                                            some: {
                                                classId: {
                                                    in: classIds,
                                                },
                                            },
                                        },
                                    },
                                },
                            },
                        ]
                        : []),
                ],
            },
            select: messageUserSelect,
            orderBy: [
                { role: 'asc' },
                { firstName: 'asc' },
                { lastName: 'asc' },
            ],
        });
    }
    if (role === client_1.Role.STUDENT) {
        const student = await prisma.student.findUnique({
            where: { userId },
            select: {
                classId: true,
            },
        });
        return prisma.user.findMany({
            where: {
                isActive: true,
                id: { not: userId },
                OR: [
                    { role: client_1.Role.ADMIN },
                    ...(student?.classId
                        ? [
                            {
                                teacherProfile: {
                                    is: {
                                        schedules: {
                                            some: {
                                                classId: student.classId,
                                            },
                                        },
                                    },
                                },
                            },
                        ]
                        : []),
                ],
            },
            select: messageUserSelect,
            orderBy: [
                { role: 'asc' },
                { firstName: 'asc' },
                { lastName: 'asc' },
            ],
        });
    }
    if (role === client_1.Role.PARENT) {
        const parent = await prisma.parent.findUnique({
            where: { userId },
            include: {
                children: {
                    select: {
                        classId: true,
                    },
                },
            },
        });
        const classIds = uniqueStringValues((parent?.children ?? []).map((child) => child.classId));
        return prisma.user.findMany({
            where: {
                isActive: true,
                id: { not: userId },
                OR: [
                    { role: client_1.Role.ADMIN },
                    ...(classIds.length > 0
                        ? [
                            {
                                teacherProfile: {
                                    is: {
                                        schedules: {
                                            some: {
                                                classId: {
                                                    in: classIds,
                                                },
                                            },
                                        },
                                    },
                                },
                            },
                        ]
                        : []),
                ],
            },
            select: messageUserSelect,
            orderBy: [
                { role: 'asc' },
                { firstName: 'asc' },
                { lastName: 'asc' },
            ],
        });
    }
    return [];
};
app.get('/', (req, res) => res.send('🎉 API is running!'));
app.get('/api/health', async (req, res) => {
    try {
        await prisma.$queryRaw `SELECT 1`;
        res.json({
            status: "ok",
            api: "running",
            database: "connected",
            timestamp: new Date().toISOString(),
        });
    }
    catch (error) {
        console.error("GET /api/health error:", error);
        res.status(500).json({
            status: "error",
            api: "running",
            database: "disconnected",
            timestamp: new Date().toISOString(),
        });
    }
});
app.post('/api/login', async (req, res) => {
    try {
        const { email, password } = req.body;
        const user = await prisma.user.findUnique({ where: { email } });
        if (!user)
            return res.status(404).json({ error: "User not found!" });
        const isPasswordValid = await bcryptjs_1.default.compare(password, user.passwordHash);
        if (!isPasswordValid)
            return res.status(401).json({ error: "Invalid password!" });
        const token = jsonwebtoken_1.default.sign({ userId: user.id, role: user.role, firstName: user.firstName }, JWT_SECRET, { expiresIn: '1d' });
        res.json({ message: "Login successful!", token, role: user.role, firstName: user.firstName, lastName: user.lastName });
    }
    catch (error) {
        res.status(500).json({ error: "Login failed" });
    }
});
// USERS
app.post('/api/register', authenticateToken, async (req, res) => {
    try {
        const { email, password, firstName, lastName, role, classId, studentUserId } = req.body;
        const existingUser = await prisma.user.findUnique({ where: { email } });
        if (existingUser)
            return res.status(400).json({ error: "Email already in use!" });
        const salt = await bcryptjs_1.default.genSalt(10);
        const hashedPassword = await bcryptjs_1.default.hash(password, salt);
        const newUser = await prisma.user.create({ data: { email, passwordHash: hashedPassword, firstName, lastName, role: role || 'STUDENT' } });
        if (role === 'STUDENT')
            await prisma.student.create({ data: { userId: newUser.id, dateOfBirth: new Date(), classId: classId || null } });
        else if (role === 'PARENT') {
            const newParent = await prisma.parent.create({ data: { userId: newUser.id } });
            if (studentUserId) {
                const studentProfile = await prisma.student.findUnique({ where: { userId: studentUserId } });
                if (studentProfile)
                    await prisma.student.update({ where: { id: studentProfile.id }, data: { parentId: newParent.id } });
            }
        }
        else if (role === 'TEACHER')
            await prisma.teacher.create({ data: { userId: newUser.id, specialty: "General", hireDate: new Date() } });
        res.status(201).json({ message: "User created!" });
    }
    catch (error) {
        res.status(500).json({ error: "Registration failed" });
    }
});
app.get('/api/users', authenticateToken, async (req, res) => {
    try {
        res.json(await prisma.user.findMany({ select: { id: true, firstName: true, lastName: true, email: true, role: true, createdAt: true }, orderBy: { createdAt: 'desc' } }));
    }
    catch (error) {
        res.status(500).json({ error: "Failed to fetch users" });
    }
});
app.put('/api/users/:id', authenticateToken, async (req, res) => {
    try {
        await prisma.user.update({ where: { id: req.params.id }, data: { firstName: req.body.firstName, lastName: req.body.lastName, email: req.body.email } });
        res.json({ message: "Updated!" });
    }
    catch (error) {
        res.status(500).json({ error: "Failed to update user" });
    }
});
app.delete('/api/users/:id', authenticateToken, async (req, res) => {
    try {
        const userId = req.params.id;
        await prisma.student.deleteMany({ where: { userId } });
        await prisma.teacher.deleteMany({ where: { userId } });
        const parentProfile = await prisma.parent.findUnique({ where: { userId } });
        if (parentProfile) {
            await prisma.student.updateMany({ where: { parentId: parentProfile.id }, data: { parentId: null } });
            await prisma.parent.delete({ where: { id: parentProfile.id } });
        }
        await prisma.user.delete({ where: { id: userId } });
        res.json({ message: "User deleted!" });
    }
    catch (error) {
        res.status(500).json({ error: "Failed to delete user" });
    }
});
// STATS, CLASSES, SUBJECTS, TEACHERS, SCHEDULES, ATTENDANCE, GRADES (Unchanged)
app.get('/api/stats', authenticateToken, async (req, res) => { try {
    res.json({ totalUsers: await prisma.user.count(), totalTeachers: await prisma.user.count({ where: { role: 'TEACHER' } }), totalStudents: await prisma.user.count({ where: { role: 'STUDENT' } }), totalAdmins: await prisma.user.count({ where: { role: 'ADMIN' } }) });
}
catch (error) {
    res.status(500).json({ error: "Failed" });
} });
app.get('/api/classes', authenticateToken, async (req, res) => { try {
    res.json(await prisma.class.findMany({ include: { _count: { select: { students: true } } }, orderBy: { name: 'asc' } }));
}
catch (error) {
    res.status(500).json({ error: "Failed" });
} });
app.post('/api/classes', authenticateToken, async (req, res) => { try {
    res.status(201).json(await prisma.class.create({ data: { name: req.body.name, academicYear: req.body.academicYear } }));
}
catch (error) {
    res.status(500).json({ error: "Failed" });
} });
app.get('/api/classes/:id', authenticateToken, async (req, res) => { try {
    res.json(await prisma.class.findUnique({ where: { id: req.params.id }, include: { students: { include: { user: { select: { firstName: true, lastName: true, email: true } } } } } }));
}
catch (error) {
    res.status(500).json({ error: "Failed" });
} });
app.delete('/api/classes/:id', authenticateToken, async (req, res) => { try {
    await prisma.class.delete({ where: { id: req.params.id } });
    res.json({ message: "Deleted!" });
}
catch (error) {
    res.status(500).json({ error: "Failed" });
} });
app.get('/api/subjects', authenticateToken, async (req, res) => { try {
    res.json(await prisma.subject.findMany({ orderBy: { name: 'asc' } }));
}
catch (error) {
    res.status(500).json({ error: "Failed" });
} });
app.post('/api/subjects', authenticateToken, async (req, res) => { try {
    res.status(201).json(await prisma.subject.create({ data: { name: req.body.name, coefficient: parseFloat(req.body.coefficient) } }));
}
catch (error) {
    res.status(500).json({ error: "Failed" });
} });
app.delete('/api/subjects/:id', authenticateToken, async (req, res) => { try {
    await prisma.subject.delete({ where: { id: req.params.id } });
    res.json({ message: "Deleted!" });
}
catch (error) {
    res.status(500).json({ error: "Failed" });
} });
app.get('/api/teachers', authenticateToken, async (req, res) => { try {
    res.json(await prisma.teacher.findMany({ include: { user: true } }));
}
catch (error) {
    res.status(500).json({ error: "Failed" });
} });
app.get('/api/schedules', authenticateToken, async (req, res) => {
    try {
        res.json(await prisma.schedule.findMany({
            include: {
                class: { include: { students: { include: { user: true } } } },
                subject: true,
                teacher: { include: { user: true } }
            },
            orderBy: { dayOfWeek: 'asc' }
        }));
    }
    catch (error) {
        res.status(500).json({ error: "Failed" });
    }
});
app.post('/api/schedules', authenticateToken, async (req, res) => {
    try {
        const { classId, subjectId, teacherId, dayOfWeek, startTime, endTime } = req.body;
        if (!classId || !subjectId || !teacherId || !dayOfWeek || !startTime || !endTime) {
            return res.status(400).json({ error: "All fields are required!" });
        }
        const createdSchedule = await prisma.schedule.create({
            data: {
                classId,
                subjectId,
                teacherId,
                dayOfWeek,
                startTime,
                endTime
            },
            include: {
                class: true,
                subject: true,
                teacher: { include: { user: true } }
            }
        });
        res.status(201).json(createdSchedule);
    }
    catch (error) {
        res.status(500).json({ error: "Failed" });
    }
});
app.put('/api/schedules/:id', authenticateToken, async (req, res) => {
    try {
        const scheduleId = req.params.id;
        const { classId, subjectId, teacherId, dayOfWeek, startTime, endTime } = req.body;
        if (!classId || !subjectId || !teacherId || !dayOfWeek || !startTime || !endTime) {
            return res.status(400).json({ error: "All fields are required!" });
        }
        const existingSchedule = await prisma.schedule.findUnique({
            where: { id: scheduleId }
        });
        if (!existingSchedule) {
            return res.status(404).json({ error: "Schedule not found!" });
        }
        const updatedSchedule = await prisma.schedule.update({
            where: { id: scheduleId },
            data: {
                classId,
                subjectId,
                teacherId,
                dayOfWeek,
                startTime,
                endTime
            },
            include: {
                class: true,
                subject: true,
                teacher: { include: { user: true } }
            }
        });
        res.json(updatedSchedule);
    }
    catch (error) {
        res.status(500).json({ error: "Failed to update schedule" });
    }
});
app.delete('/api/schedules/:id', authenticateToken, async (req, res) => {
    try {
        await prisma.schedule.delete({ where: { id: req.params.id } });
        res.json({ message: "Deleted!" });
    }
    catch (error) {
        res.status(500).json({ error: "Failed" });
    }
});
app.get('/api/attendance/:scheduleId', authenticateToken, async (req, res) => { try {
    const scheduleId = req.params.scheduleId;
    const targetDate = new Date(req.query.date);
    const startDate = new Date(targetDate);
    startDate.setHours(0, 0, 0, 0);
    const endDate = new Date(targetDate);
    endDate.setHours(23, 59, 59, 999);
    res.json(await prisma.attendance.findMany({ where: { scheduleId: scheduleId, date: { gte: startDate, lte: endDate } } }));
}
catch (error) {
    res.status(500).json({ error: "Failed" });
} });
app.post('/api/attendance', authenticateToken, async (req, res) => { try {
    const { studentId, scheduleId, status, date } = req.body;
    const targetDate = new Date(date);
    const startDate = new Date(targetDate);
    startDate.setHours(0, 0, 0, 0);
    const endDate = new Date(targetDate);
    endDate.setHours(23, 59, 59, 999);
    const existing = await prisma.attendance.findFirst({ where: { studentId, scheduleId, date: { gte: startDate, lte: endDate } } });
    if (existing)
        await prisma.attendance.update({ where: { id: existing.id }, data: { status } });
    else
        await prisma.attendance.create({ data: { studentId, scheduleId, status, date: targetDate } });
    res.json({ message: "Attendance saved!" });
}
catch (error) {
    res.status(500).json({ error: "Failed" });
} });
app.get('/api/grades/:classId/:subjectId', authenticateToken, async (req, res) => {
    try {
        const classId = req.params.classId;
        const subjectId = req.params.subjectId;
        const period = parseGradePeriod(req.query.period);
        const students = await prisma.student.findMany({
            where: { classId },
            include: {
                user: true,
                grades: {
                    where: {
                        subjectId,
                        period,
                    },
                },
            },
        });
        res.json(students);
    }
    catch (error) {
        console.error('GET /api/grades error:', error);
        res.status(500).json({ error: "Failed" });
    }
});
app.post('/api/grades', authenticateToken, async (req, res) => {
    try {
        const { studentId, subjectId, examType, period, score, comments } = req.body;
        if (!studentId || !subjectId || !examType || score === undefined || score === null) {
            return res.status(400).json({ error: "studentId, subjectId, examType, and score are required!" });
        }
        const gradePeriod = parseGradePeriod(period);
        const numericScore = parseFloat(score);
        if (Number.isNaN(numericScore)) {
            return res.status(400).json({ error: "Score must be a valid number!" });
        }
        const existing = await prisma.grade.findFirst({
            where: {
                studentId,
                subjectId,
                examType,
                period: gradePeriod,
            },
        });
        let savedGrade;
        if (existing) {
            savedGrade = await prisma.grade.update({
                where: { id: existing.id },
                data: {
                    score: numericScore,
                    comments,
                    period: gradePeriod,
                },
            });
        }
        else {
            savedGrade = await prisma.grade.create({
                data: {
                    studentId,
                    subjectId,
                    examType,
                    period: gradePeriod,
                    score: numericScore,
                    comments,
                },
            });
        }
        const studentProfile = await prisma.student.findUnique({
            where: { id: studentId },
            include: {
                user: true,
                parent: true,
            },
        });
        const subjectInfo = await prisma.subject.findUnique({
            where: { id: subjectId },
        });
        const notificationUserIds = [
            studentProfile?.userId,
            studentProfile?.parent?.userId,
        ].filter(Boolean);
        await createNotificationsForUserIds(notificationUserIds, 'New grade published', `A new ${subjectInfo?.name ?? 'subject'} grade (${numericScore}/20) was added for ${gradePeriod}.`, 'GRADE', savedGrade.id);
        res.json({ message: "Grade saved!", grade: savedGrade });
    }
    catch (error) {
        console.error('POST /api/grades error:', error);
        res.status(500).json({ error: "Failed" });
    }
});
app.get('/api/student-summary/:studentId', authenticateToken, async (req, res) => {
    try {
        const studentId = req.params.studentId;
        const period = parseGradePeriod(req.query.period);
        const student = await prisma.student.findUnique({
            where: { id: studentId },
            include: {
                user: true,
                class: true,
                grades: {
                    where: { period },
                    include: { subject: true },
                    orderBy: { createdAt: 'desc' },
                },
            },
        });
        if (!student) {
            return res.status(404).json({ error: 'Student not found!' });
        }
        const gradeGroups = new Map();
        for (const grade of student.grades) {
            const subjectId = grade.subjectId;
            const subjectName = grade.subject?.name ?? 'Unknown Subject';
            const coefficient = grade.subject?.coefficient ?? 1;
            const existing = gradeGroups.get(subjectId);
            if (existing) {
                existing.scores.push(grade.score);
            }
            else {
                gradeGroups.set(subjectId, {
                    subjectId,
                    subjectName,
                    coefficient,
                    scores: [grade.score],
                });
            }
        }
        const subjectSummaries = [...gradeGroups.values()].map((item) => {
            const average = item.scores.reduce((sum, value) => sum + value, 0) / item.scores.length;
            return {
                subjectId: item.subjectId,
                subjectName: item.subjectName,
                coefficient: item.coefficient,
                gradesCount: item.scores.length,
                average,
            };
        });
        const weightedSum = subjectSummaries.reduce((sum, item) => sum + item.average * item.coefficient, 0);
        const coefficientSum = subjectSummaries.reduce((sum, item) => sum + item.coefficient, 0);
        const generalAverage = coefficientSum > 0 ? weightedSum / coefficientSum : null;
        const allScores = student.grades.map((grade) => grade.score);
        const bestScore = allScores.length > 0 ? Math.max(...allScores) : null;
        res.json({
            student: {
                id: student.id,
                firstName: student.user?.firstName ?? '',
                lastName: student.user?.lastName ?? '',
                email: student.user?.email ?? '',
            },
            class: student.class
                ? {
                    id: student.class.id,
                    name: student.class.name,
                    academicYear: student.class.academicYear,
                }
                : null,
            period,
            gradesCount: student.grades.length,
            bestScore,
            generalAverage,
            coefficientSum,
            subjects: subjectSummaries.sort((a, b) => b.average - a.average),
        });
    }
    catch (error) {
        console.error('GET /api/student-summary/:studentId error:', error);
        res.status(500).json({ error: 'Failed to compute student summary' });
    }
});
app.get('/api/student-bulletin/:studentId', authenticateToken, async (req, res) => {
    try {
        const studentId = req.params.studentId;
        const period = parseGradePeriod(req.query.period);
        const student = await prisma.student.findUnique({
            where: { id: studentId },
            include: {
                user: true,
                class: true,
                grades: {
                    where: { period },
                    include: { subject: true },
                    orderBy: { createdAt: 'desc' },
                },
                attendances: {
                    include: {
                        schedule: { include: { subject: true } },
                    },
                    orderBy: { date: 'desc' },
                },
            },
        });
        if (!student) {
            return res.status(404).json({ error: 'Student not found!' });
        }
        const gradeGroups = new Map();
        for (const grade of student.grades) {
            const subjectId = grade.subjectId;
            const subjectName = grade.subject?.name ?? 'Unknown Subject';
            const coefficient = grade.subject?.coefficient ?? 1;
            const existing = gradeGroups.get(subjectId);
            if (existing) {
                existing.scores.push(grade.score);
            }
            else {
                gradeGroups.set(subjectId, {
                    subjectId,
                    subjectName,
                    coefficient,
                    scores: [grade.score],
                });
            }
        }
        const subjectSummaries = [...gradeGroups.values()].map((item) => {
            const average = item.scores.reduce((sum, value) => sum + value, 0) / item.scores.length;
            return {
                subjectId: item.subjectId,
                subjectName: item.subjectName,
                coefficient: item.coefficient,
                gradesCount: item.scores.length,
                average,
            };
        });
        const weightedSum = subjectSummaries.reduce((sum, item) => sum + item.average * item.coefficient, 0);
        const coefficientSum = subjectSummaries.reduce((sum, item) => sum + item.coefficient, 0);
        const generalAverage = coefficientSum > 0 ? weightedSum / coefficientSum : null;
        const allScores = student.grades.map((grade) => grade.score);
        const bestScore = allScores.length > 0 ? Math.max(...allScores) : null;
        const absencesCount = student.attendances.filter((attendance) => attendance.status === 'ABSENT').length;
        res.json({
            student: {
                id: student.id,
                firstName: student.user?.firstName ?? '',
                lastName: student.user?.lastName ?? '',
                email: student.user?.email ?? '',
            },
            class: student.class
                ? {
                    id: student.class.id,
                    name: student.class.name,
                    academicYear: student.class.academicYear,
                }
                : null,
            period,
            gradesCount: student.grades.length,
            bestScore,
            generalAverage,
            coefficientSum,
            absencesCount,
            subjects: subjectSummaries.sort((a, b) => b.average - a.average),
        });
    }
    catch (error) {
        console.error('GET /api/student-bulletin/:studentId error:', error);
        res.status(500).json({ error: 'Failed to compute bulletin' });
    }
});
// REPORTS
app.get('/api/reports/attendance', authenticateToken, async (req, res) => {
    try {
        const role = req.user.role;
        if (role !== 'ADMIN') {
            return res.status(403).json({ error: 'Only admins can access attendance reports.' });
        }
        const classId = req.query.classId;
        const from = req.query.from;
        const to = req.query.to;
        if (!classId || !from || !to) {
            return res.status(400).json({
                error: 'classId, from and to are required.',
            });
        }
        const fromDate = new Date(from);
        fromDate.setHours(0, 0, 0, 0);
        const toDate = new Date(to);
        toDate.setHours(23, 59, 59, 999);
        if (Number.isNaN(fromDate.getTime()) || Number.isNaN(toDate.getTime())) {
            return res.status(400).json({
                error: 'from and to must be valid dates.',
            });
        }
        const selectedClass = await prisma.class.findUnique({
            where: { id: classId },
            include: {
                students: {
                    include: {
                        user: {
                            select: {
                                firstName: true,
                                lastName: true,
                                email: true,
                            },
                        },
                    },
                    orderBy: {
                        user: {
                            firstName: 'asc',
                        },
                    },
                },
            },
        });
        if (!selectedClass) {
            return res.status(404).json({ error: 'Class not found.' });
        }
        const attendances = await prisma.attendance.findMany({
            where: {
                date: {
                    gte: fromDate,
                    lte: toDate,
                },
                schedule: {
                    classId,
                },
            },
            include: {
                student: {
                    include: {
                        user: true,
                    },
                },
                schedule: {
                    include: {
                        subject: true,
                        class: true,
                    },
                },
            },
            orderBy: [
                { date: 'asc' },
            ],
        });
        const rowsByStudent = new Map();
        for (const student of selectedClass.students) {
            rowsByStudent.set(student.id, {
                studentId: student.id,
                studentName: `${student.user.firstName} ${student.user.lastName}`,
                email: student.user.email,
                present: 0,
                absent: 0,
                late: 0,
                total: 0,
                absenceRate: 0,
            });
        }
        for (const attendance of attendances) {
            const row = rowsByStudent.get(attendance.studentId);
            if (!row)
                continue;
            row.total += 1;
            if (attendance.status === 'PRESENT')
                row.present += 1;
            else if (attendance.status === 'ABSENT')
                row.absent += 1;
            else if (attendance.status === 'LATE')
                row.late += 1;
        }
        const rows = Array.from(rowsByStudent.values()).map((row) => ({
            ...row,
            absenceRate: row.total > 0 ? Math.round((row.absent / row.total) * 100) : 0,
        }));
        res.json({
            class: {
                id: selectedClass.id,
                name: selectedClass.name,
                academicYear: selectedClass.academicYear,
            },
            from,
            to,
            rows,
            summary: {
                students: rows.length,
                totalPresent: rows.reduce((sum, row) => sum + row.present, 0),
                totalAbsent: rows.reduce((sum, row) => sum + row.absent, 0),
                totalLate: rows.reduce((sum, row) => sum + row.late, 0),
                totalRecords: rows.reduce((sum, row) => sum + row.total, 0),
            },
        });
    }
    catch (error) {
        console.error('GET /api/reports/attendance error:', error);
        res.status(500).json({ error: 'Failed to generate attendance report.' });
    }
});
// REPORTS - GRADES
app.get('/api/reports/grades', authenticateToken, async (req, res) => {
    try {
        const role = req.user.role;
        if (role !== 'ADMIN') {
            return res.status(403).json({ error: 'Only admins can access grades reports.' });
        }
        const classId = req.query.classId;
        const subjectId = req.query.subjectId;
        const period = parseGradePeriod(req.query.period);
        if (!classId) {
            return res.status(400).json({
                error: 'classId is required.',
            });
        }
        const selectedClass = await prisma.class.findUnique({
            where: { id: classId },
            include: {
                students: {
                    include: {
                        user: {
                            select: {
                                firstName: true,
                                lastName: true,
                                email: true,
                            },
                        },
                        grades: {
                            where: {
                                period,
                                ...(subjectId ? { subjectId } : {}),
                            },
                            include: {
                                subject: true,
                            },
                        },
                    },
                    orderBy: {
                        user: {
                            firstName: 'asc',
                        },
                    },
                },
            },
        });
        if (!selectedClass) {
            return res.status(404).json({ error: 'Class not found.' });
        }
        const rows = selectedClass.students.map((student) => {
            const scores = student.grades.map((grade) => grade.score);
            const average = scores.length > 0
                ? scores.reduce((sum, score) => sum + score, 0) / scores.length
                : null;
            const bestScore = scores.length > 0 ? Math.max(...scores) : null;
            const lowestScore = scores.length > 0 ? Math.min(...scores) : null;
            return {
                studentId: student.id,
                studentName: `${student.user.firstName} ${student.user.lastName}`,
                email: student.user.email,
                gradesCount: student.grades.length,
                average,
                bestScore,
                lowestScore,
            };
        });
        const averages = rows
            .map((row) => row.average)
            .filter((value) => value !== null);
        const classAverage = averages.length > 0
            ? averages.reduce((sum, value) => sum + value, 0) / averages.length
            : null;
        res.json({
            class: {
                id: selectedClass.id,
                name: selectedClass.name,
                academicYear: selectedClass.academicYear,
            },
            subjectId: subjectId || null,
            period,
            rows,
            summary: {
                students: rows.length,
                gradedStudents: rows.filter((row) => row.gradesCount > 0).length,
                totalGrades: rows.reduce((sum, row) => sum + row.gradesCount, 0),
                classAverage,
            },
        });
    }
    catch (error) {
        console.error('GET /api/reports/grades error:', error);
        res.status(500).json({ error: 'Failed to generate grades report.' });
    }
});
// ASSIGNMENTS
app.get('/api/assignments', authenticateToken, async (req, res) => {
    try {
        if (!isAdminOrTeacher(req)) {
            return res.status(403).json({ error: 'Only admins and teachers can view assignments.' });
        }
        const classId = req.query.classId;
        const subjectId = req.query.subjectId;
        const assignments = await prisma.assignment.findMany({
            where: {
                ...(classId ? { classId } : {}),
                ...(subjectId ? { subjectId } : {}),
            },
            include: {
                class: true,
                subject: true,
                teacher: { include: { user: true } },
                _count: { select: { submissions: true } },
            },
            orderBy: { dueDate: 'asc' },
        });
        res.json(assignments);
    }
    catch (error) {
        console.error('GET /api/assignments error:', error);
        res.status(500).json({ error: 'Failed to fetch assignments' });
    }
});
app.post('/api/assignments', authenticateToken, async (req, res) => {
    try {
        if (!isAdminOrTeacher(req)) {
            return res.status(403).json({ error: 'Only admins and teachers can create assignments.' });
        }
        const { classId, subjectId, teacherId, title, description, dueDate } = req.body;
        if (!classId || !subjectId || !title || !dueDate) {
            return res.status(400).json({ error: 'classId, subjectId, title and dueDate are required!' });
        }
        const created = await prisma.assignment.create({
            data: {
                classId,
                subjectId,
                teacherId: teacherId || null,
                title,
                description: description || null,
                dueDate: new Date(dueDate),
            },
            include: {
                class: true,
                subject: true,
                teacher: { include: { user: true } },
            },
        });
        const students = await prisma.student.findMany({
            where: { classId },
            select: { id: true },
        });
        if (students.length > 0) {
            await prisma.assignmentSubmission.createMany({
                data: students.map((student) => ({
                    assignmentId: created.id,
                    studentId: student.id,
                    status: 'PENDING',
                })),
            });
        }
        const studentProfiles = await prisma.student.findMany({
            where: { classId },
            include: {
                user: true,
                parent: {
                    include: {
                        user: true,
                    },
                },
            },
        });
        const notificationUserIds = [
            ...studentProfiles.map((student) => student.userId),
            ...studentProfiles
                .map((student) => student.parent?.userId)
                .filter(Boolean),
        ];
        await createNotificationsForUserIds(notificationUserIds, 'New assignment', `${title} has been assigned with due date ${new Date(dueDate).toLocaleString()}.`, 'ASSIGNMENT', created.id);
        res.status(201).json(created);
    }
    catch (error) {
        console.error('POST /api/assignments error:', error);
        res.status(500).json({ error: 'Failed to create assignment' });
    }
});
app.put('/api/assignments/:id', authenticateToken, async (req, res) => {
    try {
        if (!isAdminOrTeacher(req)) {
            return res.status(403).json({ error: 'Only admins and teachers can update assignments.' });
        }
        const { title, description, dueDate } = req.body;
        const updated = await prisma.assignment.update({
            where: { id: req.params.id },
            data: {
                title,
                description: description || null,
                dueDate: dueDate ? new Date(dueDate) : undefined,
            },
            include: {
                class: true,
                subject: true,
                teacher: { include: { user: true } },
            },
        });
        res.json(updated);
    }
    catch (error) {
        console.error('PUT /api/assignments/:id error:', error);
        res.status(500).json({ error: 'Failed to update assignment' });
    }
});
app.delete('/api/assignments/:id', authenticateToken, async (req, res) => {
    try {
        if (!isAdminOrTeacher(req)) {
            return res.status(403).json({ error: 'Only admins and teachers can delete assignments.' });
        }
        await prisma.assignment.delete({
            where: { id: req.params.id },
        });
        res.json({ message: 'Assignment deleted!' });
    }
    catch (error) {
        console.error('DELETE /api/assignments/:id error:', error);
        res.status(500).json({ error: 'Failed to delete assignment' });
    }
});
app.get('/api/my-assignments', authenticateToken, async (req, res) => {
    try {
        const userId = req.user.userId;
        const role = req.user.role;
        if (role === 'STUDENT') {
            const student = await prisma.student.findUnique({
                where: { userId },
                include: {
                    submissions: {
                        include: {
                            assignment: {
                                include: {
                                    class: true,
                                    subject: true,
                                    teacher: { include: { user: true } },
                                },
                            },
                        },
                    },
                },
            });
            const submissions = (student?.submissions ?? []).sort((a, b) => new Date(a.assignment.dueDate).getTime() -
                new Date(b.assignment.dueDate).getTime());
            return res.json(submissions);
        }
        if (role === 'PARENT') {
            const parent = await prisma.parent.findUnique({
                where: { userId },
                include: {
                    children: {
                        include: {
                            user: true,
                            submissions: {
                                include: {
                                    assignment: {
                                        include: {
                                            class: true,
                                            subject: true,
                                            teacher: { include: { user: true } },
                                        },
                                    },
                                },
                            },
                        },
                    },
                },
            });
            const children = (parent?.children ?? []).map((child) => ({
                ...child,
                submissions: [...child.submissions].sort((a, b) => new Date(a.assignment.dueDate).getTime() -
                    new Date(b.assignment.dueDate).getTime()),
            }));
            return res.json(children);
        }
        return res.status(403).json({ error: 'Only students and parents can view assignments.' });
    }
    catch (error) {
        console.error('GET /api/my-assignments error:', error);
        res.status(500).json({ error: 'Failed to fetch assignments' });
    }
});
app.put('/api/assignment-submissions/:id', authenticateToken, async (req, res) => {
    try {
        const userId = req.user.userId;
        const role = req.user.role;
        const submissionId = req.params.id;
        const { status, notes } = req.body;
        const submission = await prisma.assignmentSubmission.findUnique({
            where: { id: submissionId },
            include: {
                student: true,
                assignment: {
                    include: {
                        class: true,
                        subject: true,
                    },
                },
            },
        });
        if (!submission) {
            return res.status(404).json({ error: 'Assignment submission not found!' });
        }
        if (role === 'STUDENT') {
            const student = await prisma.student.findUnique({
                where: { userId },
            });
            if (!student || student.id !== submission.studentId) {
                return res.status(403).json({ error: 'You can only update your own assignments.' });
            }
        }
        else if (role === 'PARENT') {
            const parent = await prisma.parent.findUnique({
                where: { userId },
            });
            if (!parent || submission.student.parentId !== parent.id) {
                return res.status(403).json({ error: 'You can only update your child assignments.' });
            }
        }
        else {
            return res.status(403).json({ error: 'Only students and parents can update assignment submissions.' });
        }
        const normalizedStatus = parseAssignmentStatus(status);
        const updated = await prisma.assignmentSubmission.update({
            where: { id: submissionId },
            data: {
                status: normalizedStatus,
                notes: notes || null,
                submittedAt: normalizedStatus === 'DONE' ? new Date() : null,
            },
            include: {
                assignment: {
                    include: {
                        subject: true,
                        class: true,
                    },
                },
                student: {
                    include: {
                        user: true,
                    },
                },
            },
        });
        res.json(updated);
    }
    catch (error) {
        console.error('PUT /api/assignment-submissions/:id error:', error);
        res.status(500).json({ error: 'Failed to update assignment submission' });
    }
});
// ANNOUNCEMENTS
app.get('/api/announcements', authenticateToken, async (req, res) => {
    try {
        if (!isAdminOrTeacher(req)) {
            return res.status(403).json({ error: 'Only admins and teachers can view announcements.' });
        }
        const announcements = await prisma.announcement.findMany({
            include: {
                class: true,
                createdBy: {
                    select: {
                        id: true,
                        firstName: true,
                        lastName: true,
                        email: true,
                        role: true,
                    },
                },
            },
            orderBy: { createdAt: 'desc' },
        });
        res.json(announcements);
    }
    catch (error) {
        console.error('GET /api/announcements error:', error);
        res.status(500).json({ error: 'Failed to fetch announcements' });
    }
});
app.post('/api/announcements', authenticateToken, async (req, res) => {
    try {
        if (!isAdminOrTeacher(req)) {
            return res.status(403).json({ error: 'Only admins and teachers can create announcements.' });
        }
        const { title, content, audience, classId } = req.body;
        const userId = req.user.userId;
        const role = req.user.role;
        if (!title || !content) {
            return res.status(400).json({ error: 'title and content are required!' });
        }
        const parsedAudience = parseAnnouncementAudience(audience);
        const allowedAudiences = getAllowedAnnouncementAudiences(role);
        if (!allowedAudiences.includes(parsedAudience)) {
            return res.status(403).json({
                error: 'You are not allowed to create announcements for this audience.',
            });
        }
        if (parsedAudience === 'CLASS' && !classId) {
            return res.status(400).json({ error: 'classId is required when audience is CLASS.' });
        }
        const created = await prisma.announcement.create({
            data: {
                title,
                content,
                audience: parsedAudience,
                classId: parsedAudience === 'CLASS' ? classId : null,
                createdById: userId,
            },
            include: {
                class: true,
                createdBy: {
                    select: {
                        id: true,
                        firstName: true,
                        lastName: true,
                        email: true,
                        role: true,
                    },
                },
            },
        });
        let notificationUserIds = [];
        if (parsedAudience === client_1.AnnouncementAudience.ALL) {
            const users = await prisma.user.findMany({
                select: { id: true },
            });
            notificationUserIds = users.map((user) => user.id);
        }
        else if (parsedAudience === client_1.AnnouncementAudience.STUDENTS) {
            const users = await prisma.user.findMany({
                where: { role: 'STUDENT' },
                select: { id: true },
            });
            notificationUserIds = users.map((user) => user.id);
        }
        else if (parsedAudience === client_1.AnnouncementAudience.PARENTS) {
            const users = await prisma.user.findMany({
                where: { role: 'PARENT' },
                select: { id: true },
            });
            notificationUserIds = users.map((user) => user.id);
        }
        else if (parsedAudience === client_1.AnnouncementAudience.TEACHERS) {
            const users = await prisma.user.findMany({
                where: { role: 'TEACHER' },
                select: { id: true },
            });
            notificationUserIds = users.map((user) => user.id);
        }
        else if (parsedAudience === client_1.AnnouncementAudience.CLASS && classId) {
            const students = await prisma.student.findMany({
                where: { classId },
                include: {
                    parent: true,
                },
            });
            notificationUserIds = [
                ...students.map((student) => student.userId),
                ...students
                    .map((student) => student.parent?.userId)
                    .filter(Boolean),
            ];
        }
        await createNotificationsForUserIds(notificationUserIds, 'New announcement', title, 'ANNOUNCEMENT', created.id);
        res.status(201).json(created);
    }
    catch (error) {
        console.error('POST /api/announcements error:', error);
        res.status(500).json({ error: 'Failed to create announcement' });
    }
});
app.put('/api/announcements/:id', authenticateToken, async (req, res) => {
    try {
        if (!isAdminOrTeacher(req)) {
            return res.status(403).json({ error: 'Only admins and teachers can update announcements.' });
        }
        const { title, content, audience, classId } = req.body;
        const role = req.user.role;
        const existing = await prisma.announcement.findUnique({
            where: { id: req.params.id },
        });
        if (!existing) {
            return res.status(404).json({ error: 'Announcement not found!' });
        }
        if (role === 'TEACHER') {
            return res.status(403).json({
                error: 'Teachers cannot edit announcements from this page.',
            });
        }
        if (!title || !content) {
            return res.status(400).json({ error: 'title and content are required!' });
        }
        const parsedAudience = parseAnnouncementAudience(audience);
        if (parsedAudience === 'CLASS' && !classId) {
            return res.status(400).json({ error: 'classId is required when audience is CLASS.' });
        }
        const updated = await prisma.announcement.update({
            where: { id: req.params.id },
            data: {
                title,
                content,
                audience: parsedAudience,
                classId: parsedAudience === 'CLASS' ? classId : null,
            },
            include: {
                class: true,
                createdBy: {
                    select: {
                        id: true,
                        firstName: true,
                        lastName: true,
                        email: true,
                        role: true,
                    },
                },
            },
        });
        res.json(updated);
    }
    catch (error) {
        console.error('PUT /api/announcements/:id error:', error);
        res.status(500).json({ error: 'Failed to update announcement' });
    }
});
app.delete('/api/announcements/:id', authenticateToken, async (req, res) => {
    try {
        if (!isAdminOrTeacher(req)) {
            return res.status(403).json({ error: 'Only admins and teachers can delete announcements.' });
        }
        const role = req.user.role;
        if (role === 'TEACHER') {
            return res.status(403).json({
                error: 'Teachers cannot delete announcements from this page.',
            });
        }
        await prisma.announcement.delete({
            where: { id: req.params.id },
        });
        res.json({ message: 'Announcement deleted!' });
    }
    catch (error) {
        console.error('DELETE /api/announcements/:id error:', error);
        res.status(500).json({ error: 'Failed to delete announcement' });
    }
});
app.get('/api/my-announcements', authenticateToken, async (req, res) => {
    try {
        const userId = req.user.userId;
        const role = req.user.role;
        if (role === 'STUDENT') {
            const student = await prisma.student.findUnique({
                where: { userId },
            });
            const announcements = await prisma.announcement.findMany({
                where: {
                    OR: [
                        { audience: client_1.AnnouncementAudience.ALL },
                        { audience: client_1.AnnouncementAudience.STUDENTS },
                        ...(student?.classId
                            ? [{ audience: client_1.AnnouncementAudience.CLASS, classId: student.classId }]
                            : []),
                    ],
                },
                include: {
                    class: true,
                    createdBy: {
                        select: {
                            firstName: true,
                            lastName: true,
                            role: true,
                        },
                    },
                },
                orderBy: { createdAt: 'desc' },
            });
            return res.json(announcements);
        }
        if (role === 'PARENT') {
            const parent = await prisma.parent.findUnique({
                where: { userId },
                include: { children: true },
            });
            const classIds = (parent?.children ?? [])
                .map((child) => child.classId)
                .filter(Boolean);
            const announcements = await prisma.announcement.findMany({
                where: {
                    OR: [
                        { audience: client_1.AnnouncementAudience.ALL },
                        { audience: client_1.AnnouncementAudience.PARENTS },
                        ...(classIds.length > 0
                            ? [{ audience: client_1.AnnouncementAudience.CLASS, classId: { in: classIds } }]
                            : []),
                    ],
                },
                include: {
                    class: true,
                    createdBy: {
                        select: {
                            firstName: true,
                            lastName: true,
                            role: true,
                        },
                    },
                },
                orderBy: { createdAt: 'desc' },
            });
            return res.json(announcements);
        }
        if (role === 'TEACHER') {
            const announcements = await prisma.announcement.findMany({
                where: {
                    OR: [
                        { audience: client_1.AnnouncementAudience.ALL },
                        { audience: client_1.AnnouncementAudience.TEACHERS },
                    ],
                },
                include: {
                    class: true,
                    createdBy: {
                        select: {
                            firstName: true,
                            lastName: true,
                            role: true,
                        },
                    },
                },
                orderBy: { createdAt: 'desc' },
            });
            return res.json(announcements);
        }
        return res.status(403).json({ error: 'Role not allowed for announcements.' });
    }
    catch (error) {
        console.error('GET /api/my-announcements error:', error);
        res.status(500).json({ error: 'Failed to fetch announcements' });
    }
});
// NOTIFICATIONS
app.get('/api/my-notifications', authenticateToken, async (req, res) => {
    try {
        const userId = req.user.userId;
        const notifications = await prisma.notification.findMany({
            where: { userId },
            orderBy: { createdAt: 'desc' },
        });
        res.json(notifications);
    }
    catch (error) {
        console.error('GET /api/my-notifications error:', error);
        res.status(500).json({ error: 'Failed to fetch notifications' });
    }
});
app.put('/api/notifications/:id/read', authenticateToken, async (req, res) => {
    try {
        const userId = req.user.userId;
        const notificationId = req.params.id;
        const notification = await prisma.notification.findUnique({
            where: { id: notificationId },
        });
        if (!notification) {
            return res.status(404).json({ error: 'Notification not found!' });
        }
        if (notification.userId !== userId) {
            return res.status(403).json({ error: 'You can only update your own notifications.' });
        }
        const updated = await prisma.notification.update({
            where: { id: notificationId },
            data: { isRead: true },
        });
        res.json(updated);
    }
    catch (error) {
        console.error('PUT /api/notifications/:id/read error:', error);
        res.status(500).json({ error: 'Failed to update notification' });
    }
});
app.post('/api/notify-bulletin/:studentId', authenticateToken, async (req, res) => {
    try {
        if (!isAdminOrTeacher(req)) {
            return res.status(403).json({ error: 'Only admins and teachers can publish bulletin notifications.' });
        }
        const studentId = req.params.studentId;
        const period = parseGradePeriod(req.body?.period);
        const student = await prisma.student.findUnique({
            where: { id: studentId },
            include: {
                user: true,
                parent: true,
            },
        });
        if (!student) {
            return res.status(404).json({ error: 'Student not found!' });
        }
        const notificationUserIds = [
            student.userId,
            student.parent?.userId,
        ].filter(Boolean);
        await createNotificationsForUserIds(notificationUserIds, 'Bulletin available', `Your ${period} bulletin is now available.`, 'BULLETIN', studentId);
        res.json({ message: 'Bulletin notification sent!' });
    }
    catch (error) {
        console.error('POST /api/notify-bulletin/:studentId error:', error);
        res.status(500).json({ error: 'Failed to send bulletin notification' });
    }
});
app.get('/api/my-teacher-overview', authenticateToken, async (req, res) => {
    try {
        const userId = req.user.userId;
        const role = req.user.role;
        if (role !== 'TEACHER') {
            return res.status(403).json({ error: 'Only teachers can access this overview.' });
        }
        const teacher = await prisma.teacher.findUnique({
            where: { userId },
            include: {
                user: {
                    select: {
                        id: true,
                        firstName: true,
                        lastName: true,
                        email: true,
                        role: true,
                    },
                },
                schedules: {
                    include: {
                        class: true,
                        subject: true,
                    },
                    orderBy: [
                        { dayOfWeek: 'asc' },
                        { startTime: 'asc' },
                    ],
                },
                assignments: {
                    include: {
                        class: true,
                        subject: true,
                        _count: { select: { submissions: true } },
                    },
                    orderBy: { dueDate: 'asc' },
                },
            },
        });
        if (!teacher) {
            return res.status(404).json({ error: 'Teacher profile not found!' });
        }
        const announcements = await prisma.announcement.findMany({
            where: {
                OR: [
                    { audience: client_1.AnnouncementAudience.ALL },
                    { audience: client_1.AnnouncementAudience.TEACHERS },
                ],
            },
            include: {
                class: true,
                createdBy: {
                    select: {
                        firstName: true,
                        lastName: true,
                        role: true,
                    },
                },
            },
            orderBy: { createdAt: 'desc' },
            take: 10,
        });
        const notifications = await prisma.notification.findMany({
            where: { userId },
            orderBy: { createdAt: 'desc' },
            take: 10,
        });
        res.json({
            teacher: {
                id: teacher.id,
                specialty: teacher.specialty,
                hireDate: teacher.hireDate,
                user: teacher.user,
            },
            schedules: teacher.schedules,
            assignments: teacher.assignments,
            announcements,
            notifications,
        });
    }
    catch (error) {
        console.error('GET /api/my-teacher-overview error:', error);
        res.status(500).json({ error: 'Failed to fetch teacher overview' });
    }
});
// MESSAGES
app.get('/api/messages/recipients', authenticateToken, async (req, res) => {
    try {
        const userId = req.user.userId;
        const role = req.user.role;
        const recipients = await getAllowedMessageRecipients(userId, role);
        res.json(recipients);
    }
    catch (error) {
        console.error('GET /api/messages/recipients error:', error);
        res.status(500).json({ error: 'Failed to fetch message recipients.' });
    }
});
app.get('/api/messages/conversations', authenticateToken, async (req, res) => {
    try {
        const userId = req.user.userId;
        const conversations = await prisma.conversation.findMany({
            where: {
                participants: {
                    some: {
                        userId,
                    },
                },
            },
            include: {
                participants: {
                    include: {
                        user: {
                            select: messageUserSelect,
                        },
                    },
                },
                messages: {
                    include: {
                        sender: {
                            select: messageUserSelect,
                        },
                    },
                    orderBy: {
                        createdAt: 'desc',
                    },
                    take: 1,
                },
            },
            orderBy: {
                updatedAt: 'desc',
            },
        });
        const conversationsWithUnread = await Promise.all(conversations.map(async (conversation) => {
            const currentParticipant = conversation.participants.find((participant) => participant.userId === userId);
            const unreadCount = await prisma.message.count({
                where: {
                    conversationId: conversation.id,
                    senderId: {
                        not: userId,
                    },
                    ...(currentParticipant?.lastReadAt
                        ? {
                            createdAt: {
                                gt: currentParticipant.lastReadAt,
                            },
                        }
                        : {}),
                },
            });
            const { messages, ...conversationWithoutMessages } = conversation;
            return {
                ...conversationWithoutMessages,
                lastMessage: messages[0] ?? null,
                unreadCount,
            };
        }));
        res.json(conversationsWithUnread);
    }
    catch (error) {
        console.error('GET /api/messages/conversations error:', error);
        res.status(500).json({ error: 'Failed to fetch conversations.' });
    }
});
app.get('/api/messages/conversations/:id', authenticateToken, async (req, res) => {
    try {
        const userId = req.user.userId;
        const conversationId = req.params.id;
        const conversation = await prisma.conversation.findFirst({
            where: {
                id: conversationId,
                participants: {
                    some: {
                        userId,
                    },
                },
            },
            include: {
                participants: {
                    include: {
                        user: {
                            select: messageUserSelect,
                        },
                    },
                },
                messages: {
                    include: {
                        sender: {
                            select: messageUserSelect,
                        },
                    },
                    orderBy: {
                        createdAt: 'asc',
                    },
                },
            },
        });
        if (!conversation) {
            return res.status(404).json({ error: 'Conversation not found.' });
        }
        await prisma.conversationParticipant.updateMany({
            where: {
                conversationId,
                userId,
            },
            data: {
                lastReadAt: new Date(),
            },
        });
        res.json(conversation);
    }
    catch (error) {
        console.error('GET /api/messages/conversations/:id error:', error);
        res.status(500).json({ error: 'Failed to fetch conversation.' });
    }
});
app.post('/api/messages/conversations', authenticateToken, async (req, res) => {
    try {
        const userId = req.user.userId;
        const role = req.user.role;
        const { title, participantIds, message } = req.body;
        const cleanParticipantIds = Array.isArray(participantIds)
            ? uniqueStringValues(participantIds.filter((participantId) => typeof participantId === 'string')).filter((participantId) => participantId !== userId)
            : [];
        const cleanMessage = typeof message === 'string' && message.trim()
            ? message.trim()
            : '';
        if (cleanParticipantIds.length === 0) {
            return res.status(400).json({ error: 'At least one participant is required.' });
        }
        const allowedRecipients = await getAllowedMessageRecipients(userId, role);
        const allowedRecipientIds = new Set(allowedRecipients.map((user) => user.id));
        const forbiddenParticipantIds = cleanParticipantIds.filter((participantId) => !allowedRecipientIds.has(participantId));
        if (forbiddenParticipantIds.length > 0) {
            return res.status(403).json({
                error: 'You are not allowed to start a conversation with one or more selected users.',
            });
        }
        const allParticipantIds = uniqueStringValues([userId, ...cleanParticipantIds]);
        const now = new Date();
        const createdConversation = await prisma.conversation.create({
            data: {
                title: typeof title === 'string' && title.trim()
                    ? title.trim()
                    : null,
                participants: {
                    create: allParticipantIds.map((participantId) => ({
                        userId: participantId,
                        lastReadAt: participantId === userId ? now : null,
                    })),
                },
            },
        });
        let createdMessage = null;
        if (cleanMessage) {
            createdMessage = await prisma.message.create({
                data: {
                    conversationId: createdConversation.id,
                    senderId: userId,
                    body: cleanMessage,
                },
            });
            await prisma.conversation.update({
                where: {
                    id: createdConversation.id,
                },
                data: {
                    updatedAt: new Date(),
                },
            });
            await createNotificationsForUserIds(cleanParticipantIds, 'New message', cleanMessage.length > 120 ? `${cleanMessage.slice(0, 120)}...` : cleanMessage, 'MESSAGE', createdConversation.id);
        }
        const fullConversation = await prisma.conversation.findUnique({
            where: {
                id: createdConversation.id,
            },
            include: {
                participants: {
                    include: {
                        user: {
                            select: messageUserSelect,
                        },
                    },
                },
                messages: {
                    include: {
                        sender: {
                            select: messageUserSelect,
                        },
                    },
                    orderBy: {
                        createdAt: 'asc',
                    },
                },
            },
        });
        res.status(201).json({
            conversation: fullConversation,
            message: createdMessage,
        });
    }
    catch (error) {
        console.error('POST /api/messages/conversations error:', error);
        res.status(500).json({ error: 'Failed to create conversation.' });
    }
});
app.post('/api/messages/conversations/:id/messages', authenticateToken, async (req, res) => {
    try {
        const userId = req.user.userId;
        const conversationId = req.params.id;
        const { body } = req.body;
        const cleanBody = typeof body === 'string' && body.trim()
            ? body.trim()
            : '';
        if (!cleanBody) {
            return res.status(400).json({ error: 'Message body is required.' });
        }
        const conversation = await prisma.conversation.findFirst({
            where: {
                id: conversationId,
                participants: {
                    some: {
                        userId,
                    },
                },
            },
            include: {
                participants: true,
            },
        });
        if (!conversation) {
            return res.status(404).json({ error: 'Conversation not found.' });
        }
        const createdMessage = await prisma.message.create({
            data: {
                conversationId,
                senderId: userId,
                body: cleanBody,
            },
            include: {
                sender: {
                    select: messageUserSelect,
                },
            },
        });
        await prisma.conversation.update({
            where: {
                id: conversationId,
            },
            data: {
                updatedAt: new Date(),
            },
        });
        await prisma.conversationParticipant.updateMany({
            where: {
                conversationId,
                userId,
            },
            data: {
                lastReadAt: new Date(),
            },
        });
        const recipientUserIds = conversation.participants
            .map((participant) => participant.userId)
            .filter((participantUserId) => participantUserId !== userId);
        await createNotificationsForUserIds(recipientUserIds, 'New message', cleanBody.length > 120 ? `${cleanBody.slice(0, 120)}...` : cleanBody, 'MESSAGE', conversationId);
        res.status(201).json(createdMessage);
    }
    catch (error) {
        console.error('POST /api/messages/conversations/:id/messages error:', error);
        res.status(500).json({ error: 'Failed to send message.' });
    }
});
app.put('/api/messages/conversations/:id/read', authenticateToken, async (req, res) => {
    try {
        const userId = req.user.userId;
        const conversationId = req.params.id;
        const participant = await prisma.conversationParticipant.findFirst({
            where: {
                conversationId,
                userId,
            },
        });
        if (!participant) {
            return res.status(404).json({ error: 'Conversation not found.' });
        }
        const updatedParticipant = await prisma.conversationParticipant.update({
            where: {
                id: participant.id,
            },
            data: {
                lastReadAt: new Date(),
            },
        });
        res.json({
            message: 'Conversation marked as read.',
            participant: updatedParticipant,
        });
    }
    catch (error) {
        console.error('PUT /api/messages/conversations/:id/read error:', error);
        res.status(500).json({ error: 'Failed to mark conversation as read.' });
    }
});
// --- NEW MAGIC: THE STUDENT/PARENT PORTAL ---
app.get('/api/my-portal', authenticateToken, async (req, res) => {
    try {
        const userId = req.user.userId;
        const role = req.user.role;
        if (role === 'STUDENT') {
            // Find the student and ALL their grades, attendance, and class schedules!
            const studentInfo = await prisma.student.findUnique({
                where: { userId: userId },
                include: {
                    user: true,
                    class: { include: { schedules: { include: { subject: true, teacher: { include: { user: true } } } } } },
                    grades: { include: { subject: true }, orderBy: { createdAt: 'desc' } },
                    attendances: { include: { schedule: { include: { subject: true } } }, orderBy: { date: 'desc' } }
                }
            });
            return res.json(studentInfo);
        }
        else if (role === 'PARENT') {
            // Find the parent and grab THEIR CHILD's info!
            const parentInfo = await prisma.parent.findUnique({
                where: { userId: userId },
                include: {
                    children: {
                        include: {
                            user: true,
                            class: {
                                include: {
                                    schedules: {
                                        include: {
                                            subject: true,
                                            teacher: { include: { user: true } }
                                        }
                                    }
                                }
                            },
                            grades: { include: { subject: true }, orderBy: { createdAt: 'desc' } },
                            attendances: { include: { schedule: { include: { subject: true } } }, orderBy: { date: 'desc' } }
                        }
                    }
                }
            });
            return res.json(parentInfo);
        }
        res.status(403).json({ error: "Only Students and Parents can view this." });
    }
    catch (error) {
        res.status(500).json({ error: "Failed to fetch portal data" });
    }
});
const getOrCreateSchoolSettings = async () => {
    const existingSettings = await prisma.schoolSettings.findFirst({
        orderBy: {
            createdAt: "asc",
        },
    });
    if (existingSettings) {
        return existingSettings;
    }
    return prisma.schoolSettings.create({
        data: {
            schoolName: "School ERP",
            schoolSubtitle: "Tunisian Public School",
            academicYear: "2025-2026",
            defaultTrimester: "TRIMESTER_1",
            defaultReportFrom: new Date("2026-04-01T00:00:00.000Z"),
            defaultReportTo: new Date("2026-04-24T00:00:00.000Z"),
        },
    });
};
const parseNullableDateInput = (value) => {
    if (value === undefined)
        return undefined;
    if (value === null || value === "")
        return null;
    const date = new Date(String(value));
    if (Number.isNaN(date.getTime())) {
        return "INVALID_DATE";
    }
    return date;
};
// SCHOOL SETTINGS
app.get("/api/settings/school", authenticateToken, async (req, res) => {
    try {
        const settings = await getOrCreateSchoolSettings();
        res.json(settings);
    }
    catch (error) {
        console.error("GET /api/settings/school error:", error);
        res.status(500).json({ error: "Failed to fetch school settings." });
    }
});
app.put("/api/settings/school", authenticateToken, async (req, res) => {
    try {
        const role = req.user.role;
        if (role !== "ADMIN") {
            return res.status(403).json({
                error: "Only admins can update school settings.",
            });
        }
        const existingSettings = await getOrCreateSchoolSettings();
        const { schoolName, schoolSubtitle, academicYear, defaultTrimester, defaultReportFrom, defaultReportTo, } = req.body;
        const parsedDefaultReportFrom = parseNullableDateInput(defaultReportFrom);
        const parsedDefaultReportTo = parseNullableDateInput(defaultReportTo);
        if (parsedDefaultReportFrom === "INVALID_DATE" ||
            parsedDefaultReportTo === "INVALID_DATE") {
            return res.status(400).json({
                error: "defaultReportFrom and defaultReportTo must be valid dates.",
            });
        }
        const updatedSettings = await prisma.schoolSettings.update({
            where: {
                id: existingSettings.id,
            },
            data: {
                schoolName: typeof schoolName === "string" && schoolName.trim()
                    ? schoolName.trim()
                    : existingSettings.schoolName,
                schoolSubtitle: typeof schoolSubtitle === "string" && schoolSubtitle.trim()
                    ? schoolSubtitle.trim()
                    : existingSettings.schoolSubtitle,
                academicYear: typeof academicYear === "string" && academicYear.trim()
                    ? academicYear.trim()
                    : existingSettings.academicYear,
                defaultTrimester: typeof defaultTrimester === "string"
                    ? parseGradePeriod(defaultTrimester)
                    : existingSettings.defaultTrimester,
                defaultReportFrom: parsedDefaultReportFrom === undefined
                    ? existingSettings.defaultReportFrom
                    : parsedDefaultReportFrom,
                defaultReportTo: parsedDefaultReportTo === undefined
                    ? existingSettings.defaultReportTo
                    : parsedDefaultReportTo,
            },
        });
        res.json(updatedSettings);
    }
    catch (error) {
        console.error("PUT /api/settings/school error:", error);
        res.status(500).json({ error: "Failed to update school settings." });
    }
});
app.listen(PORT, () => console.log(`🚀 Server is running on http://localhost:${PORT}`));
