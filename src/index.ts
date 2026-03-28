import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import { PrismaClient, GradePeriod } from '@prisma/client';
import { Pool } from 'pg';
import { PrismaPg } from '@prisma/adapter-pg';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import 'dotenv/config';

const connectionString = process.env.DATABASE_URL;
const JWT_SECRET = process.env.JWT_SECRET;
const PORT = Number(process.env.PORT || 5000);

if (!connectionString) {
  throw new Error("DATABASE_URL is missing");
}

if (!JWT_SECRET) {
  throw new Error("JWT_SECRET is missing");
}

const pool = new Pool({ connectionString });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

const app = express();

const parseGradePeriod = (value?: string): GradePeriod => {
  if (value === 'TRIMESTER_2') return 'TRIMESTER_2';
  if (value === 'TRIMESTER_3') return 'TRIMESTER_3';
  return 'TRIMESTER_1';
};


app.use(cors());
app.use(express.json());

const authenticateToken = (req: Request, res: Response, next: NextFunction): any => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  if (!token) return res.status(401).json({ error: "Access denied!" });

  jwt.verify(token, JWT_SECRET, (err: any, user: any) => {
    if (err) return res.status(403).json({ error: "Invalid token!" });
    (req as any).user = user; next(); 
  });
};

app.get('/', (req: Request, res: Response) => res.send('🎉 API is running!'));

app.post('/api/login', async (req: Request, res: Response): Promise<any> => {
  try {
    const { email, password } = req.body;
    const user = await prisma.user.findUnique({ where: { email } });
    if (!user) return res.status(404).json({ error: "User not found!" });
    const isPasswordValid = await bcrypt.compare(password, user.passwordHash);
    if (!isPasswordValid) return res.status(401).json({ error: "Invalid password!" });
    const token = jwt.sign({ userId: user.id, role: user.role, firstName: user.firstName }, JWT_SECRET, { expiresIn: '1d' });
    res.json({ message: "Login successful!", token, role: user.role, firstName: user.firstName, lastName: user.lastName });
  } catch (error) { res.status(500).json({ error: "Login failed" }); }
});

// USERS
app.post('/api/register', authenticateToken, async (req: Request, res: Response): Promise<any> => {
  try {
    const { email, password, firstName, lastName, role, classId, studentUserId } = req.body;
    const existingUser = await prisma.user.findUnique({ where: { email } });
    if (existingUser) return res.status(400).json({ error: "Email already in use!" });
    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(password, salt);
    
    const newUser = await prisma.user.create({ data: { email, passwordHash: hashedPassword, firstName, lastName, role: role || 'STUDENT' } });

    if (role === 'STUDENT') await prisma.student.create({ data: { userId: newUser.id, dateOfBirth: new Date(), classId: classId || null } });
    else if (role === 'PARENT') {
      const newParent = await prisma.parent.create({ data: { userId: newUser.id } });
      if (studentUserId) {
        const studentProfile = await prisma.student.findUnique({ where: { userId: studentUserId } });
        if (studentProfile) await prisma.student.update({ where: { id: studentProfile.id }, data: { parentId: newParent.id } });
      }
    } else if (role === 'TEACHER') await prisma.teacher.create({ data: { userId: newUser.id, specialty: "General", hireDate: new Date() } });

    res.status(201).json({ message: "User created!" });
  } catch (error) { res.status(500).json({ error: "Registration failed" }); }
});
app.get('/api/users', authenticateToken, async (req: Request, res: Response) => {
  try { res.json(await prisma.user.findMany({ select: { id: true, firstName: true, lastName: true, email: true, role: true, createdAt: true }, orderBy: { createdAt: 'desc' } })); } 
  catch (error) { res.status(500).json({ error: "Failed to fetch users" }); }
});
app.put('/api/users/:id', authenticateToken, async (req: Request, res: Response): Promise<any> => {
  try { await prisma.user.update({ where: { id: req.params.id as string }, data: { firstName: req.body.firstName, lastName: req.body.lastName, email: req.body.email } }); res.json({ message: "Updated!" }); } 
  catch (error) { res.status(500).json({ error: "Failed to update user" }); }
});
app.delete('/api/users/:id', authenticateToken, async (req: Request, res: Response): Promise<any> => {
  try {
    const userId = req.params.id as string;
    await prisma.student.deleteMany({ where: { userId } });
    await prisma.teacher.deleteMany({ where: { userId } }); 
    const parentProfile = await prisma.parent.findUnique({ where: { userId } });
    if (parentProfile) {
      await prisma.student.updateMany({ where: { parentId: parentProfile.id }, data: { parentId: null } });
      await prisma.parent.delete({ where: { id: parentProfile.id } });
    }
    await prisma.user.delete({ where: { id: userId } });
    res.json({ message: "User deleted!" });
  } catch (error) { res.status(500).json({ error: "Failed to delete user" }); }
});

// STATS, CLASSES, SUBJECTS, TEACHERS, SCHEDULES, ATTENDANCE, GRADES (Unchanged)
app.get('/api/stats', authenticateToken, async (req: Request, res: Response) => { try { res.json({ totalUsers: await prisma.user.count(), totalTeachers: await prisma.user.count({ where: { role: 'TEACHER' } }), totalStudents: await prisma.user.count({ where: { role: 'STUDENT' } }), totalAdmins: await prisma.user.count({ where: { role: 'ADMIN' } }) }); } catch (error) { res.status(500).json({ error: "Failed" }); } });
app.get('/api/classes', authenticateToken, async (req: Request, res: Response) => { try { res.json(await prisma.class.findMany({ include: { _count: { select: { students: true } } }, orderBy: { name: 'asc' } })); } catch (error) { res.status(500).json({ error: "Failed" }); } });
app.post('/api/classes', authenticateToken, async (req: Request, res: Response): Promise<any> => { try { res.status(201).json(await prisma.class.create({ data: { name: req.body.name, academicYear: req.body.academicYear } })); } catch (error) { res.status(500).json({ error: "Failed" }); } });
app.get('/api/classes/:id', authenticateToken, async (req: Request, res: Response): Promise<any> => { try { res.json(await prisma.class.findUnique({ where: { id: req.params.id as string }, include: { students: { include: { user: { select: { firstName: true, lastName: true, email: true } } } } } })); } catch (error) { res.status(500).json({ error: "Failed" }); } });
app.delete('/api/classes/:id', authenticateToken, async (req: Request, res: Response): Promise<any> => { try { await prisma.class.delete({ where: { id: req.params.id as string } }); res.json({ message: "Deleted!" }); } catch (error) { res.status(500).json({ error: "Failed" }); } });
app.get('/api/subjects', authenticateToken, async (req: Request, res: Response) => { try { res.json(await prisma.subject.findMany({ orderBy: { name: 'asc' } })); } catch (error) { res.status(500).json({ error: "Failed" }); } });
app.post('/api/subjects', authenticateToken, async (req: Request, res: Response): Promise<any> => { try { res.status(201).json(await prisma.subject.create({ data: { name: req.body.name, coefficient: parseFloat(req.body.coefficient) } })); } catch (error) { res.status(500).json({ error: "Failed" }); } });
app.delete('/api/subjects/:id', authenticateToken, async (req: Request, res: Response): Promise<any> => { try { await prisma.subject.delete({ where: { id: req.params.id as string } }); res.json({ message: "Deleted!" }); } catch (error) { res.status(500).json({ error: "Failed" }); } });
app.get('/api/teachers', authenticateToken, async (req: Request, res: Response) => { try { res.json(await prisma.teacher.findMany({ include: { user: true } })); } catch (error) { res.status(500).json({ error: "Failed" }); } });
app.get('/api/schedules', authenticateToken, async (req: Request, res: Response) => {
  try {
    res.json(
      await prisma.schedule.findMany({
        include: {
          class: { include: { students: { include: { user: true } } } },
          subject: true,
          teacher: { include: { user: true } }
        },
        orderBy: { dayOfWeek: 'asc' }
      })
    );
  } catch (error) {
    res.status(500).json({ error: "Failed" });
  }
});

app.post('/api/schedules', authenticateToken, async (req: Request, res: Response): Promise<any> => {
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
  } catch (error) {
    res.status(500).json({ error: "Failed" });
  }
});

app.put('/api/schedules/:id', authenticateToken, async (req: Request, res: Response): Promise<any> => {
  try {
    const scheduleId = req.params.id as string;
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
  } catch (error) {
    res.status(500).json({ error: "Failed to update schedule" });
  }
});

app.delete('/api/schedules/:id', authenticateToken, async (req: Request, res: Response): Promise<any> => {
  try {
    await prisma.schedule.delete({ where: { id: req.params.id as string } });
    res.json({ message: "Deleted!" });
  } catch (error) {
    res.status(500).json({ error: "Failed" });
  }
});
app.get('/api/attendance/:scheduleId', authenticateToken, async (req: Request, res: Response): Promise<any> => { try { const scheduleId = req.params.scheduleId as string; const targetDate = new Date(req.query.date as string); const startDate = new Date(targetDate); startDate.setHours(0,0,0,0); const endDate = new Date(targetDate); endDate.setHours(23,59,59,999); res.json(await prisma.attendance.findMany({ where: { scheduleId: scheduleId, date: { gte: startDate, lte: endDate } } })); } catch (error) { res.status(500).json({ error: "Failed" }); } });
app.post('/api/attendance', authenticateToken, async (req: Request, res: Response): Promise<any> => { try { const { studentId, scheduleId, status, date } = req.body; const targetDate = new Date(date); const startDate = new Date(targetDate); startDate.setHours(0,0,0,0); const endDate = new Date(targetDate); endDate.setHours(23,59,59,999); const existing = await prisma.attendance.findFirst({ where: { studentId, scheduleId, date: { gte: startDate, lte: endDate } } }); if (existing) await prisma.attendance.update({ where: { id: existing.id }, data: { status } }); else await prisma.attendance.create({ data: { studentId, scheduleId, status, date: targetDate } }); res.json({ message: "Attendance saved!" }); } catch (error) { res.status(500).json({ error: "Failed" }); } });
app.get('/api/grades/:classId/:subjectId', authenticateToken, async (req: Request, res: Response): Promise<any> => {
  try {
    const classId = req.params.classId as string;
    const subjectId = req.params.subjectId as string;
    const period = parseGradePeriod(req.query.period as string | undefined);

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
  } catch (error) {
  console.error('GET /api/grades error:', error);
  res.status(500).json({ error: "Failed" });
}
});
app.post('/api/grades', authenticateToken, async (req: Request, res: Response): Promise<any> => {
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

    if (existing) {
      await prisma.grade.update({
        where: { id: existing.id },
        data: {
          score: numericScore,
          comments,
          period: gradePeriod,
        },
      });
    } else {
      await prisma.grade.create({
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

    res.json({ message: "Grade saved!" });
  } catch (error) {
  console.error('POST /api/grades error:', error);
  res.status(500).json({ error: "Failed" });
}
});

app.get('/api/student-summary/:studentId', authenticateToken, async (req: Request, res: Response): Promise<any> => {
  try {
    const studentId = req.params.studentId as string;
    const period = parseGradePeriod(req.query.period as string | undefined);

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

    const gradeGroups = new Map<
      string,
      {
        subjectId: string;
        subjectName: string;
        coefficient: number;
        scores: number[];
      }
    >();

    for (const grade of student.grades) {
      const subjectId = grade.subjectId;
      const subjectName = grade.subject?.name ?? 'Unknown Subject';
      const coefficient = grade.subject?.coefficient ?? 1;

      const existing = gradeGroups.get(subjectId);

      if (existing) {
        existing.scores.push(grade.score);
      } else {
        gradeGroups.set(subjectId, {
          subjectId,
          subjectName,
          coefficient,
          scores: [grade.score],
        });
      }
    }

    const subjectSummaries = [...gradeGroups.values()].map((item) => {
      const average =
        item.scores.reduce((sum, value) => sum + value, 0) / item.scores.length;

      return {
        subjectId: item.subjectId,
        subjectName: item.subjectName,
        coefficient: item.coefficient,
        gradesCount: item.scores.length,
        average,
      };
    });

    const weightedSum = subjectSummaries.reduce(
      (sum, item) => sum + item.average * item.coefficient,
      0
    );

    const coefficientSum = subjectSummaries.reduce(
      (sum, item) => sum + item.coefficient,
      0
    );

    const generalAverage =
      coefficientSum > 0 ? weightedSum / coefficientSum : null;

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
  } catch (error) {
    console.error('GET /api/student-summary/:studentId error:', error);
    res.status(500).json({ error: 'Failed to compute student summary' });
  }
});

app.get('/api/student-bulletin/:studentId', authenticateToken, async (req: Request, res: Response): Promise<any> => {
  try {
    const studentId = req.params.studentId as string;
    const period = parseGradePeriod(req.query.period as string | undefined);

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

    const gradeGroups = new Map<
      string,
      {
        subjectId: string;
        subjectName: string;
        coefficient: number;
        scores: number[];
      }
    >();

    for (const grade of student.grades) {
      const subjectId = grade.subjectId;
      const subjectName = grade.subject?.name ?? 'Unknown Subject';
      const coefficient = grade.subject?.coefficient ?? 1;

      const existing = gradeGroups.get(subjectId);

      if (existing) {
        existing.scores.push(grade.score);
      } else {
        gradeGroups.set(subjectId, {
          subjectId,
          subjectName,
          coefficient,
          scores: [grade.score],
        });
      }
    }

    const subjectSummaries = [...gradeGroups.values()].map((item) => {
      const average =
        item.scores.reduce((sum, value) => sum + value, 0) / item.scores.length;

      return {
        subjectId: item.subjectId,
        subjectName: item.subjectName,
        coefficient: item.coefficient,
        gradesCount: item.scores.length,
        average,
      };
    });

    const weightedSum = subjectSummaries.reduce(
      (sum, item) => sum + item.average * item.coefficient,
      0
    );

    const coefficientSum = subjectSummaries.reduce(
      (sum, item) => sum + item.coefficient,
      0
    );

    const generalAverage =
      coefficientSum > 0 ? weightedSum / coefficientSum : null;

    const allScores = student.grades.map((grade) => grade.score);
    const bestScore = allScores.length > 0 ? Math.max(...allScores) : null;

    const absencesCount = student.attendances.filter(
      (attendance) => attendance.status === 'ABSENT'
    ).length;

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
  } catch (error) {
    console.error('GET /api/student-bulletin/:studentId error:', error);
    res.status(500).json({ error: 'Failed to compute bulletin' });
  }
});

// --- NEW MAGIC: THE STUDENT/PARENT PORTAL ---
app.get('/api/my-portal', authenticateToken, async (req: Request, res: Response): Promise<any> => {
  try {
    const userId = (req as any).user.userId;
    const role = (req as any).user.role;

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
  } catch (error) {
    res.status(500).json({ error: "Failed to fetch portal data" });
  }
});

app.listen(PORT, () => console.log(`🚀 Server is running on http://localhost:${PORT}`));