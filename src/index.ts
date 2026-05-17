import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import path from 'path';
import fs from 'fs';
import multer from 'multer';
import { v2 as cloudinary, UploadApiResponse } from 'cloudinary';
import { PrismaClient, Prisma, GradePeriod, AnnouncementAudience, Role } from '@prisma/client';
import { Pool } from 'pg';
import { PrismaPg } from '@prisma/adapter-pg';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { randomBytes } from 'crypto';
import 'dotenv/config';

const connectionString = process.env.DATABASE_URL;
const JWT_SECRET = process.env.JWT_SECRET;
const PORT = Number(process.env.PORT || 5000);

const CLOUDINARY_CLOUD_NAME = process.env.CLOUDINARY_CLOUD_NAME;
const CLOUDINARY_API_KEY = process.env.CLOUDINARY_API_KEY;
const CLOUDINARY_API_SECRET = process.env.CLOUDINARY_API_SECRET;

const isCloudinaryConfigured = Boolean(
  CLOUDINARY_CLOUD_NAME &&
    CLOUDINARY_API_KEY &&
    CLOUDINARY_API_SECRET
);

if (isCloudinaryConfigured) {
  cloudinary.config({
    cloud_name: CLOUDINARY_CLOUD_NAME,
    api_key: CLOUDINARY_API_KEY,
    api_secret: CLOUDINARY_API_SECRET,
  });
}

if (!connectionString) {
  throw new Error("DATABASE_URL is missing");
}

if (!JWT_SECRET) {
  throw new Error("JWT_SECRET is missing");
}

const pool = new Pool({
  connectionString,
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000,
});
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

const app = express();

const uploadsDir = path.join(process.cwd(), 'uploads');

if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 2 * 1024 * 1024,
  },
  fileFilter: (req, file, callback) => {
    const allowedTypes = ['image/jpeg', 'image/png', 'image/webp'];

    if (!allowedTypes.includes(file.mimetype)) {
      return callback(null, false);
    }

    callback(null, true);
  },
});

const uploadProfileImageToCloudinary = (
  file: Express.Multer.File,
  userId: string
) => {
  return new Promise<UploadApiResponse>((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      {
        folder: 'school-erp/profile-images',
        public_id: `${userId}-${Date.now()}`,
        resource_type: 'image',
        overwrite: true,
        transformation: [
          {
            width: 400,
            height: 400,
            crop: 'fill',
            gravity: 'face',
          },
          {
            quality: 'auto',
            fetch_format: 'auto',
          },
        ],
      },
      (error, result) => {
        if (error || !result) {
          reject(error || new Error('Cloudinary upload failed'));
          return;
        }

        resolve(result);
      }
    );

    stream.end(file.buffer);
  });
};

const parseGradePeriod = (value?: string): GradePeriod => {
  if (value === 'TRIMESTER_2') return 'TRIMESTER_2';
  if (value === 'TRIMESTER_3') return 'TRIMESTER_3';
  return 'TRIMESTER_1';
};


app.use(cors());
app.use('/uploads', express.static(uploadsDir));
app.use(express.json());

const authenticateToken = (req: Request, res: Response, next: NextFunction): any => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  if (!token) return res.status(401).json({ error: "Access denied!" });

  jwt.verify(token, JWT_SECRET, (err: any, user: any) => {
    if (err) return res.status(403).json({ error: "Invalid token!" });

    if (user?.role === Role.STUDENT) {
      return res.status(403).json({
        error: 'Student accounts cannot access the system directly. Please use a parent account.',
      });
    }

    (req as any).user = user;
    next();
  });
};

const requireAdmin = (req: Request, res: Response, next: NextFunction): any => {
  const role = (req as any).user?.role;

  if (role !== 'ADMIN') {
    return res.status(403).json({ error: 'Only admins can access this resource.' });
  }

  next();
};

const isAdminOrTeacher = (req: Request) => {
  const role = (req as any).user?.role;
  return role === 'ADMIN' || role === 'TEACHER';
};

const getTeacherProfileId = async (userId: string) => {
  const teacher = await prisma.teacher.findUnique({
    where: { userId },
    select: { id: true },
  });

  return teacher?.id ?? null;
};

const getTeacherClassIds = async (teacherId: string) => {
  const schedules = await prisma.schedule.findMany({
    where: { teacherId },
    select: { classId: true },
  });

  return uniqueStringValues(schedules.map((schedule) => schedule.classId));
};

const teacherHasClassSubjectScope = async (
  teacherId: string,
  classId: string,
  subjectId: string
) => {
  const schedule = await prisma.schedule.findFirst({
    where: {
      teacherId,
      classId,
      subjectId,
    },
    select: { id: true },
  });

  return Boolean(schedule);
};

const teacherHasStudentScope = async (teacherId: string, studentId: string) => {
  const student = await prisma.student.findUnique({
    where: { id: studentId },
    select: {
      id: true,
      classId: true,
    },
  });

  if (!student?.classId) {
    return { allowed: false, student: null };
  }

  const teacherClassIds = await getTeacherClassIds(teacherId);

  return {
    allowed: teacherClassIds.includes(student.classId),
    student,
  };
};

const timeRangesOverlap = (
  startA: string,
  endA: string,
  startB: string,
  endB: string
) => {
  return startA < endB && startB < endA;
};

const findScheduleConflicts = async ({
  classId,
  teacherId,
  dayOfWeek,
  startTime,
  endTime,
  excludeScheduleId,
}: {
  classId: string;
  teacherId: string;
  dayOfWeek: string;
  startTime: string;
  endTime: string;
  excludeScheduleId?: string;
}) => {
  const candidates = await prisma.schedule.findMany({
    where: {
      dayOfWeek,
      ...(excludeScheduleId ? { id: { not: excludeScheduleId } } : {}),
      OR: [{ classId }, { teacherId }],
    },
    select: {
      id: true,
      classId: true,
      teacherId: true,
      startTime: true,
      endTime: true,
    },
  });

  const conflicts = candidates.filter((schedule) =>
    timeRangesOverlap(startTime, endTime, schedule.startTime, schedule.endTime)
  );

  return {
    classConflict: conflicts.find((schedule) => schedule.classId === classId) ?? null,
    teacherConflict: conflicts.find((schedule) => schedule.teacherId === teacherId) ?? null,
  };
};

const isValidTimeValue = (value: unknown) => {
  if (typeof value !== 'string') return false;

  const normalized = value.trim();
  return /^([01]\d|2[0-3]):([0-5]\d)$/.test(normalized);
};

const parseAssignmentStatus = (value?: string) => {
  const normalized = String(value ?? '').trim().toUpperCase();

  if (normalized === 'DONE') return 'DONE';
  if (normalized === 'PENDING') return 'PENDING';

  return null;
};

const parseAttendanceStatus = (value?: string) => {
  const normalized = String(value ?? '').trim().toUpperCase();

  if (normalized === 'ABSENT') return 'ABSENT';
  if (normalized === 'LATE') return 'LATE';
  if (normalized === 'PRESENT') return 'PRESENT';

  return null;
};

const parseAnnouncementAudience = (value?: string): AnnouncementAudience => {
  if (value === 'STUDENTS') return 'STUDENTS';
  if (value === 'PARENTS') return 'PARENTS';
  if (value === 'TEACHERS') return 'TEACHERS';
  if (value === 'CLASS') return 'CLASS';
  return 'ALL';
};

const getAllowedAnnouncementAudiences = (
  role: string
): AnnouncementAudience[] => {
  if (role === "ADMIN") {
    return [
      AnnouncementAudience.ALL,
      AnnouncementAudience.STUDENTS,
      AnnouncementAudience.PARENTS,
      AnnouncementAudience.TEACHERS,
      AnnouncementAudience.CLASS,
    ];
  }

  if (role === "TEACHER") {
    return [
      AnnouncementAudience.TEACHERS,
      AnnouncementAudience.CLASS,
    ];
  }

  return [];
};

const createNotificationsForUserIds = async (
  userIds: string[],
  title: string,
  message: string,
  type: string,
  relatedId?: string | null
) => {
  const uniqueUserIds = [...new Set(userIds.filter(Boolean))];

  if (uniqueUserIds.length === 0) return;

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

const createAuditLog = async (
  req: Request,
  data: {
    action: string;
    entity: string;
    entityId?: string | null;
    details?: Prisma.InputJsonValue;
  }
) => {
  try {
    const authUser = (req as any).user;
    const actorId = authUser?.userId ?? null;

    const actor = actorId
      ? await prisma.user.findUnique({
          where: { id: actorId },
          select: {
            firstName: true,
            lastName: true,
            role: true,
          },
        })
      : null;

    await prisma.auditLog.create({
      data: {
        actorId,
        actorRole: (actor?.role ?? authUser?.role ?? null) as Role | null,
        actorName: actor
          ? `${actor.firstName} ${actor.lastName}`.trim()
          : authUser?.firstName ?? null,
        action: data.action,
        entity: data.entity,
        entityId: data.entityId ?? null,
        details: data.details ?? undefined,
        ipAddress: req.ip || req.socket.remoteAddress || null,
      },
    });
  } catch (error) {
    console.error('Audit log failed:', error);
  }
};

const publicUserSelect = {
  id: true,
  firstName: true,
  lastName: true,
  email: true,
  role: true,
  profileImage: true,
} as const;

const messageUserSelect = publicUserSelect;

const uniqueStringValues = (values: Array<string | null | undefined>) => {
  return [...new Set(values.filter(Boolean) as string[])];
};

const getAllowedMessageRecipients = async (userId: string, role: string) => {
  if (role === Role.ADMIN) {
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

  if (role === Role.TEACHER) {
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

    const classIds = uniqueStringValues(
      (teacher?.schedules ?? []).map((schedule) => schedule.classId)
    );

    return prisma.user.findMany({
      where: {
        isActive: true,
        id: { not: userId },
        OR: [
          { role: Role.ADMIN },
          { role: Role.TEACHER },
          ...(classIds.length > 0
            ? [
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


  if (role === Role.PARENT) {
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

    const classIds = uniqueStringValues(
      (parent?.children ?? []).map((child) => child.classId)
    );

    return prisma.user.findMany({
      where: {
        isActive: true,
        id: { not: userId },
        OR: [
          { role: Role.ADMIN },
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

app.get('/', (req: Request, res: Response) => res.send('ðŸŽ‰ API is running!'));

app.get('/api/health', async (req: Request, res: Response): Promise<any> => {
  try {
    await prisma.$queryRaw`SELECT 1`;

    res.json({
      status: "ok",
      api: "running",
      database: "connected",
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.error("GET /api/health error:", error);

    res.status(500).json({
      status: "error",
      api: "running",
      database: "disconnected",
      timestamp: new Date().toISOString(),
    });
  }
});

app.get('/api/audit-logs', authenticateToken, requireAdmin, async (req: Request, res: Response): Promise<any> => {
  try {
    const page = Math.max(Number(req.query.page || 1), 1);
    const limit = Math.min(Math.max(Number(req.query.limit || 50), 1), 100);
    const skip = (page - 1) * limit;

    const action = String(req.query.action ?? '').trim();
    const entity = String(req.query.entity ?? '').trim();
    const actorRole = String(req.query.actorRole ?? '').trim().toUpperCase();

    const where: any = {};

    if (action) {
      where.action = {
        contains: action,
        mode: 'insensitive',
      };
    }

    if (entity) {
      where.entity = {
        contains: entity,
        mode: 'insensitive',
      };
    }

    if (['ADMIN', 'TEACHER', 'STUDENT', 'PARENT'].includes(actorRole)) {
      where.actorRole = actorRole as Role;
    }

    const [logs, total] = await Promise.all([
      prisma.auditLog.findMany({
        where,
        include: {
          actor: {
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
        skip,
        take: limit,
      }),
      prisma.auditLog.count({ where }),
    ]);

    res.json({
      data: logs,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    });
  } catch (error) {
    console.error('GET /api/audit-logs error:', error);
    res.status(500).json({ error: 'Failed to fetch audit logs' });
  }
});

app.post('/api/login', async (req: Request, res: Response): Promise<any> => {
  try {
    const normalizedEmail = String(req.body.email ?? '').trim().toLowerCase();
    const normalizedPassword = String(req.body.password ?? '');

    if (!normalizedEmail || !normalizedPassword) {
      return res.status(400).json({
        error: 'email and password are required!',
      });
    }
    const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

    if (!emailPattern.test(normalizedEmail)) {
      return res.status(400).json({
        error: 'Email must be valid!',
      });
    }

    const user = await prisma.user.findUnique({
      where: { email: normalizedEmail },
    });

    if (!user) {
      return res.status(404).json({ error: "User not found!" });
    }

    if (!user.isActive) {
      return res.status(403).json({ error: 'This account is inactive.' });
    }

    if (user.role === Role.STUDENT) {
      return res.status(403).json({
        error:
          'Student accounts cannot access the system directly. Please use a parent account.',
      });
    }

    const isPasswordValid = await bcrypt.compare(
      normalizedPassword,
      user.passwordHash
    );

    if (!isPasswordValid) {
      return res.status(401).json({ error: "Invalid password!" });
    }

    const token = jwt.sign(
      { userId: user.id, role: user.role, firstName: user.firstName },
      JWT_SECRET,
      { expiresIn: '1d' }
    );

    res.json({
      message: "Login successful!",
      token,
      role: user.role,
      firstName: user.firstName,
      lastName: user.lastName,
      profileImage: user.profileImage,
    });
  } catch (error) {
    res.status(500).json({ error: "Login failed" });
  }
});

// USERS
app.post('/api/register', authenticateToken, requireAdmin, async (req: Request, res: Response): Promise<any> => {
  try {
    const { email, password, firstName, lastName, role, classId, studentUserId } = req.body;

    const normalizedRole = String(role ?? Role.PARENT).trim().toUpperCase() as Role;
    const isStudentRole = normalizedRole === Role.STUDENT;
    const normalizedEmail = isStudentRole ? '' : String(email ?? '').trim().toLowerCase();
    const normalizedFirstName = String(firstName ?? '').trim();
    const normalizedLastName = String(lastName ?? '').trim();
    const normalizedPassword = isStudentRole ? randomBytes(32).toString('hex') : String(password ?? '');

    const normalizedClassId =
      classId === undefined || classId === null || String(classId).trim() === ''
        ? null
        : String(classId).trim();

    const normalizedStudentUserId =
      studentUserId === undefined || studentUserId === null || String(studentUserId).trim() === ''
        ? null
        : String(studentUserId).trim();

    const allowedRoles: Role[] = [
      Role.ADMIN,
      Role.TEACHER,
      Role.STUDENT,
      Role.PARENT,
    ];
    if (
      !normalizedFirstName ||
      !normalizedLastName ||
      (!isStudentRole && (!normalizedEmail || !normalizedPassword))
    ) {
      return res.status(400).json({
        error: isStudentRole
          ? 'firstName and lastName are required for student records!'
          : 'email, password, firstName and lastName are required!',
      });
    }

    const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

    if (!isStudentRole && !emailPattern.test(normalizedEmail)) {
      return res.status(400).json({
        error: 'Email must be valid!',
      });
    }

    if (!allowedRoles.includes(normalizedRole)) {
      return res.status(400).json({
        error: 'Role is invalid!',
      });
    }
    if (!isStudentRole) {
      const existingUser = await prisma.user.findUnique({
        where: { email: normalizedEmail },
        select: { id: true },
      });

      if (existingUser) {
        return res.status(400).json({ error: 'Email already in use!' });
      }
    }

    let validatedClassId: string | null = null;

    if (isStudentRole && normalizedClassId) {
      const existingClass = await prisma.class.findUnique({
        where: { id: normalizedClassId },
        select: { id: true },
      });

      if (!existingClass) {
        return res.status(400).json({
          error: 'Selected class does not exist!',
        });
      }

      validatedClassId = existingClass.id;
    }

    let studentToLink: { id: string; parentId: string | null } | null = null;

    if (normalizedRole === Role.PARENT && normalizedStudentUserId) {
      studentToLink = await prisma.student.findUnique({
        where: { userId: normalizedStudentUserId },
        select: {
          id: true,
          parentId: true,
        },
      });

      if (!studentToLink) {
        return res.status(400).json({
          error: 'Selected student does not exist!',
        });
      }

      if (studentToLink.parentId) {
        return res.status(400).json({
          error: 'This student is already linked to a parent!',
        });
      }
    }
    const passwordToHash = isStudentRole
      ? randomBytes(32).toString('hex')
      : normalizedPassword;

    const loginEmail = isStudentRole
      ? `student-${randomBytes(16).toString('hex')}@internal.school.local`
      : normalizedEmail;

    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(passwordToHash, salt);

    const createdUser = await prisma.$transaction(async (tx) => {
      const newUser = await tx.user.create({
        data: {
          email: loginEmail,
          passwordHash: hashedPassword,
          firstName: normalizedFirstName,
          lastName: normalizedLastName,
          role: normalizedRole,
        },
      });

      if (isStudentRole) {
        await tx.student.create({
          data: {
            userId: newUser.id,
            dateOfBirth: new Date(),
            classId: validatedClassId,
          },
        });
      } else if (normalizedRole === Role.PARENT) {
        const newParent = await tx.parent.create({
          data: {
            userId: newUser.id,
          },
        });

        if (studentToLink) {
          await tx.student.update({
            where: { id: studentToLink.id },
            data: { parentId: newParent.id },
          });
        }
      } else if (normalizedRole === Role.TEACHER) {
        await tx.teacher.create({
          data: {
            userId: newUser.id,
            specialty: 'General',
            hireDate: new Date(),
          },
        });
      }

      return newUser;
    });

    await createAuditLog(req, {
      action: 'CREATE_USER',
      entity: 'User',
      entityId: createdUser.id,
      details: {
        email: isStudentRole ? null : createdUser.email,
        firstName: createdUser.firstName,
        lastName: createdUser.lastName,
        role: createdUser.role,
      },
    });

    return res.status(201).json({ message: 'User created!' });
  } catch (error) {
    console.error('POST /api/register error:', error);
    return res.status(500).json({ error: 'Registration failed' });
  }
});
app.get('/api/users', authenticateToken, requireAdmin, async (req: Request, res: Response) => {
  try {
    res.json(
      await prisma.user.findMany({
        select: {
          ...publicUserSelect,
          createdAt: true,
        },
        orderBy: { createdAt: 'desc' },
      })
    );
  } catch (error) {
    res.status(500).json({ error: "Failed to fetch users" });
  }
});

app.post(
  '/api/users/:id/profile-image',
  authenticateToken,
  requireAdmin,
  upload.single('profileImage'),
  async (req: Request, res: Response): Promise<any> => {
    try {
      const userId = req.params.id as string;

      if (!req.file) {
        return res.status(400).json({
          error: 'Please upload a valid image file: JPG, PNG or WEBP, max 2MB.',
        });
      }

      const existingUser = await prisma.user.findUnique({
        where: { id: userId },
        select: {
          id: true,
          firstName: true,
          lastName: true,
          email: true,
          profileImage: true,
        },
      });

      if (!existingUser) {
        return res.status(404).json({ error: 'User not found!' });
      }

      if (!isCloudinaryConfigured) {
        return res.status(500).json({
          error: 'Cloudinary is not configured on the server.',
        });
      }

      const uploadedImage = await uploadProfileImageToCloudinary(req.file, userId);
      const profileImage = uploadedImage.secure_url;

      const updatedUser = await prisma.user.update({
        where: { id: userId },
        data: {
          profileImage,
        },
        select: {
          ...publicUserSelect,
          createdAt: true,
        },
      });

      if (existingUser.profileImage?.startsWith('/uploads/')) {
        const previousFilePath = path.join(
          uploadsDir,
          path.basename(existingUser.profileImage)
        );

        if (fs.existsSync(previousFilePath)) {
          fs.unlinkSync(previousFilePath);
        }
      }

      await createAuditLog(req, {
        action: 'UPDATE_USER_PROFILE_IMAGE',
        entity: 'User',
        entityId: updatedUser.id,
        details: {
          email: existingUser.email,
          firstName: existingUser.firstName,
          lastName: existingUser.lastName,
          profileImage,
        },
      });

      return res.json({
        message: 'Profile image updated!',
        user: updatedUser,
      });
    } catch (error) {
      console.error('POST /api/users/:id/profile-image error:', error);
      return res.status(500).json({ error: 'Failed to update profile image' });
    }
  }
);

app.put(
  '/api/users/:id/password',
  authenticateToken,
  requireAdmin,
  async (req: Request, res: Response): Promise<any> => {
    try {
      const userId = req.params.id as string;
      const newPassword = String(req.body.password ?? '');

      const existingUser = await prisma.user.findUnique({
        where: { id: userId },
        select: {
          id: true,
          email: true,
          firstName: true,
          lastName: true,
          role: true,
        },
      });

      if (!existingUser) {
        return res.status(404).json({
          error: 'User not found!',
        });
      }

      if (existingUser.role === Role.STUDENT) {
        return res.status(400).json({
          error: 'Student records do not have direct login credentials!',
        });
      }

      if (!newPassword) {
        return res.status(400).json({ error: 'password is required!' });
      }

      if (newPassword.length < 10) {
        return res.status(400).json({
          error: 'Password must be at least 10 characters long!',
        });
      }

      const salt = await bcrypt.genSalt(10);
      const passwordHash = await bcrypt.hash(newPassword, salt);

      await prisma.user.update({
        where: { id: userId },
        data: { passwordHash },
      });

      await createAuditLog(req, {
        action: 'UPDATE_USER_PASSWORD',
        entity: 'User',
        entityId: existingUser.id,
        details: {
          email: existingUser.email,
          firstName: existingUser.firstName,
          lastName: existingUser.lastName,
          role: existingUser.role,
        },
      });

      return res.json({ message: 'Password updated!' });
    } catch (error) {
      console.error('PUT /api/users/:id/password error:', error);
      return res.status(500).json({ error: 'Failed to update password' });
    }
  }
);

app.put('/api/users/:id', authenticateToken, requireAdmin, async (req: Request, res: Response): Promise<any> => {
  try {
    const userId = req.params.id as string;
    const normalizedFirstName = String(req.body.firstName ?? '').trim();
    const normalizedLastName = String(req.body.lastName ?? '').trim();
    const normalizedEmail = String(req.body.email ?? '').trim().toLowerCase();

    const existingUser = await prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        email: true,
        role: true,
      },
    });

    if (!existingUser) {
      return res.status(404).json({ error: 'User not found!' });
    }

    const isStudentRole = existingUser.role === Role.STUDENT;

    if (
      !normalizedFirstName ||
      !normalizedLastName ||
      (!isStudentRole && !normalizedEmail)
    ) {
      return res.status(400).json({
        error: isStudentRole
          ? 'firstName and lastName are required for student records!'
          : 'firstName, lastName and email are required!',
      });
    }

    const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

    if (!isStudentRole && !emailPattern.test(normalizedEmail)) {
      return res.status(400).json({
        error: 'Email must be valid!',
      });
    }

    if (!isStudentRole) {
      const emailOwner = await prisma.user.findUnique({
        where: { email: normalizedEmail },
        select: { id: true },
      });

      if (emailOwner && emailOwner.id !== userId) {
        return res.status(400).json({ error: 'Email already in use!' });
      }
    }

    const updateData: {
      firstName: string;
      lastName: string;
      email?: string;
    } = {
      firstName: normalizedFirstName,
      lastName: normalizedLastName,
    };

    if (!isStudentRole) {
      updateData.email = normalizedEmail;
    }

    const updatedUser = await prisma.user.update({
      where: { id: userId },
      data: updateData,
    });

    await createAuditLog(req, {
      action: 'UPDATE_USER',
      entity: 'User',
      entityId: updatedUser.id,
      details: {
        email: isStudentRole ? null : updatedUser.email,
        firstName: updatedUser.firstName,
        lastName: updatedUser.lastName,
        role: updatedUser.role,
      },
    });

    return res.json(updatedUser);
  } catch (error) {
    console.error('PUT /api/users/:id error:', error);
    res.status(500).json({ error: 'Failed to update user' });
  }
});

app.delete('/api/users/:id', authenticateToken, requireAdmin, async (req: Request, res: Response): Promise<any> => {
  try {
    const userId = req.params.id as string;

    const userToDelete = await prisma.user.findUnique({
  where: { id: userId },
  select: {
    id: true,
    email: true,
    firstName: true,
    lastName: true,
    role: true,
  },
});

if (!userToDelete) {
  return res.status(404).json({ error: 'User not found!' });
}

const currentUserId = (req as any).user.userId;

if (userId === currentUserId) {
  return res.status(400).json({
    error: 'You cannot delete your own account.',
  });
}

if (userToDelete.role === Role.ADMIN) {
  const adminCount = await prisma.user.count({
    where: { role: Role.ADMIN },
  });

  if (adminCount <= 1) {
    return res.status(400).json({
      error: 'You cannot delete the last admin account.',
    });
  }
}
    await prisma.student.deleteMany({ where: { userId } });
    await prisma.teacher.deleteMany({ where: { userId } }); 
    const parentProfile = await prisma.parent.findUnique({ where: { userId } });
    if (parentProfile) {
      await prisma.student.updateMany({ where: { parentId: parentProfile.id }, data: { parentId: null } });
      await prisma.parent.delete({ where: { id: parentProfile.id } });
    }
    await prisma.user.delete({ where: { id: userId } });

    await createAuditLog(req, {
  action: 'DELETE_USER',
  entity: 'User',
  entityId: userToDelete.id,
  details: {
    email: userToDelete.email,
    firstName: userToDelete.firstName,
    lastName: userToDelete.lastName,
    role: userToDelete.role,
  },
});
    res.json({ message: "User deleted!" });
  } catch (error) { res.status(500).json({ error: "Failed to delete user" }); }
});

// STATS, CLASSES, SUBJECTS, TEACHERS, SCHEDULES, ATTENDANCE, GRADES (Unchanged)
app.get('/api/stats', authenticateToken, requireAdmin, async (req: Request, res: Response) => { try { res.json({ totalUsers: await prisma.user.count(), totalTeachers: await prisma.user.count({ where: { role: 'TEACHER' } }), totalStudents: await prisma.user.count({ where: { role: 'STUDENT' } }), totalAdmins: await prisma.user.count({ where: { role: 'ADMIN' } }) }); } catch (error) { res.status(500).json({ error: "Failed" }); } });
app.get('/api/classes', authenticateToken, requireAdmin, async (req: Request, res: Response) => { try { res.json(await prisma.class.findMany({ include: { _count: { select: { students: true } } }, orderBy: { name: 'asc' } })); } catch (error) { res.status(500).json({ error: "Failed" }); } });
app.post('/api/classes', authenticateToken, requireAdmin, async (req: Request, res: Response): Promise<any> => {
  try {
    const normalizedName = String(req.body.name ?? '').trim();
    const normalizedAcademicYear = String(req.body.academicYear ?? '').trim();

    if (!normalizedName || !normalizedAcademicYear) {
      return res.status(400).json({
        error: 'name and academicYear are required!',
      });
    }

    const existingClass = await prisma.class.findFirst({
      where: {
        name: normalizedName,
        academicYear: normalizedAcademicYear,
      },
      select: { id: true },
    });

    if (existingClass) {
      return res.status(400).json({
        error: 'A class with the same name and academic year already exists!',
      });
    }

    const createdClass = await prisma.class.create({
      data: {
        name: normalizedName,
        academicYear: normalizedAcademicYear,
      },
    });

    await createAuditLog(req, {
  action: 'CREATE_CLASS',
  entity: 'Class',
  entityId: createdClass.id,
  details: {
    name: createdClass.name,
    academicYear: createdClass.academicYear,
  },
});

    res.status(201).json(createdClass);
  } catch (error) {
    res.status(500).json({ error: 'Failed' });
  }
});
app.get('/api/classes/:id', authenticateToken, requireAdmin, async (req: Request, res: Response): Promise<any> => {
  try {
    res.json(
      await prisma.class.findUnique({
        where: { id: req.params.id as string },
        include: {
          students: {
            include: {
              user: {
                select: publicUserSelect,
              },
            },
          },
        },
      })
    );
  } catch (error) {
    res.status(500).json({ error: "Failed" });
  }
});
app.delete('/api/classes/:id', authenticateToken, requireAdmin, async (req: Request, res: Response): Promise<any> => {
  try {
    const classId = req.params.id as string;

    const classToDelete = await prisma.class.findUnique({
      where: { id: classId },
      select: {
        id: true,
        name: true,
        academicYear: true,
      },
    });

    if (!classToDelete) {
      return res.status(404).json({ error: 'Class not found!' });
    }

    await prisma.class.delete({ where: { id: classId } });

    await createAuditLog(req, {
      action: 'DELETE_CLASS',
      entity: 'Class',
      entityId: classToDelete.id,
      details: {
        name: classToDelete.name,
        academicYear: classToDelete.academicYear,
      },
    });

    res.json({ message: "Deleted!" });
  } catch (error) {
    res.status(500).json({ error: "Failed" });
  }
});
app.get('/api/subjects', authenticateToken, requireAdmin, async (req: Request, res: Response) => { try { res.json(await prisma.subject.findMany({ orderBy: { name: 'asc' } })); } catch (error) { res.status(500).json({ error: "Failed" }); } });
app.post('/api/subjects', authenticateToken, requireAdmin, async (req: Request, res: Response): Promise<any> => {
  try {
    const normalizedName = String(req.body.name ?? '').trim();
    const { coefficient } = req.body;

    if (!normalizedName || coefficient === undefined || coefficient === null) {
      return res.status(400).json({
        error: 'name and coefficient are required!',
      });
    }

    const numericCoefficient = parseFloat(String(coefficient));

    if (Number.isNaN(numericCoefficient)) {
      return res.status(400).json({
        error: 'Coefficient must be a valid number!',
      });
    }

    if (numericCoefficient <= 0) {
      return res.status(400).json({
        error: 'Coefficient must be greater than 0!',
      });
    }

    const existingSubject = await prisma.subject.findFirst({
      where: {
        name: normalizedName,
      },
      select: { id: true },
    });

    if (existingSubject) {
      return res.status(400).json({
        error: 'A subject with the same name already exists!',
      });
    }

    const createdSubject = await prisma.subject.create({
      data: {
        name: normalizedName,
        coefficient: numericCoefficient,
      },
    });

    await createAuditLog(req, {
  action: 'CREATE_SUBJECT',
  entity: 'Subject',
  entityId: createdSubject.id,
  details: {
    name: createdSubject.name,
    coefficient: createdSubject.coefficient,
  },
});

    res.status(201).json(createdSubject);
  } catch (error) {
    res.status(500).json({ error: 'Failed' });
  }
});
app.delete('/api/subjects/:id', authenticateToken, requireAdmin, async (req: Request, res: Response): Promise<any> => {
  try {
    const subjectId = req.params.id as string;

    const subjectToDelete = await prisma.subject.findUnique({
      where: { id: subjectId },
      select: {
        id: true,
        name: true,
        coefficient: true,
      },
    });

    if (!subjectToDelete) {
      return res.status(404).json({ error: 'Subject not found!' });
    }

    await prisma.subject.delete({ where: { id: subjectId } });

    await createAuditLog(req, {
      action: 'DELETE_SUBJECT',
      entity: 'Subject',
      entityId: subjectToDelete.id,
      details: {
        name: subjectToDelete.name,
        coefficient: subjectToDelete.coefficient,
      },
    });

    res.json({ message: "Deleted!" });
  } catch (error) {
    res.status(500).json({ error: "Failed" });
  }
});
app.get('/api/teachers', authenticateToken, requireAdmin, async (req: Request, res: Response) => {
  try {
    res.json(
      await prisma.teacher.findMany({
        include: {
          user: {
            select: publicUserSelect,
          },
        },
      })
    );
  } catch (error) {
    res.status(500).json({ error: "Failed" });
  }
});
app.get('/api/schedules', authenticateToken, async (req: Request, res: Response): Promise<any> => {
  try {
    const userId = (req as any).user.userId;
    const role = (req as any).user.role;

    if (role !== 'ADMIN' && role !== 'TEACHER') {
      return res.status(403).json({ error: 'Only admins and teachers can view schedules.' });
    }

    let teacherIdFilter: string | undefined;

    if (role === 'TEACHER') {
      const teacherId = await getTeacherProfileId(userId);

      if (!teacherId) {
        return res.status(404).json({ error: 'Teacher profile not found!' });
      }

      teacherIdFilter = teacherId;
    }

    const schedules = await prisma.schedule.findMany({
      where: teacherIdFilter ? { teacherId: teacherIdFilter } : undefined,
      include: {
  class: {
    include: {
      students: {
        include: {
          user: {
            select: publicUserSelect,
          },
        },
      },
    },
  },
  subject: true,
  teacher: {
    include: {
      user: {
        select: publicUserSelect,
      },
    },
  },
},
      orderBy: [
        { dayOfWeek: 'asc' },
        { startTime: 'asc' },
      ],
    });

    res.json(schedules);
  } catch (error) {
    console.error('GET /api/schedules error:', error);
    res.status(500).json({ error: 'Failed' });
  }
});

app.post('/api/schedules', authenticateToken, requireAdmin, async (req: Request, res: Response): Promise<any> => {
  try {
    const { classId, subjectId, teacherId, dayOfWeek, startTime, endTime } = req.body;

    if (!classId || !subjectId || !teacherId || !dayOfWeek || !startTime || !endTime) {
      return res.status(400).json({ error: "All fields are required!" });
    }

    const normalizedDayOfWeek = String(dayOfWeek).trim();
    const normalizedStartTime = String(startTime).trim();
    const normalizedEndTime = String(endTime).trim();

    if (!normalizedDayOfWeek) {
      return res.status(400).json({ error: "dayOfWeek is required!" });
    }

    if (!isValidTimeValue(normalizedStartTime) || !isValidTimeValue(normalizedEndTime)) {
      return res.status(400).json({
        error: "startTime and endTime must use HH:MM format!",
      });
    }

    if (normalizedEndTime <= normalizedStartTime) {
      return res.status(400).json({
        error: "endTime must be later than startTime!",
      });
    }

    const { classConflict, teacherConflict } = await findScheduleConflicts({
  classId,
  teacherId,
  dayOfWeek: normalizedDayOfWeek,
  startTime: normalizedStartTime,
  endTime: normalizedEndTime,
});

if (classConflict) {
  return res.status(409).json({
    error: 'This class already has another schedule that overlaps with this time slot.',
  });
}

if (teacherConflict) {
  return res.status(409).json({
    error: 'This teacher already has another schedule that overlaps with this time slot.',
  });
}

    const createdSchedule = await prisma.schedule.create({
      data: {
        classId,
        subjectId,
        teacherId,
        dayOfWeek: normalizedDayOfWeek,
        startTime: normalizedStartTime,
        endTime: normalizedEndTime
      },
      include: {
        class: true,
        subject: true,
        teacher: { include: { user: {
  select: publicUserSelect,
} } }
      }
    });

    await createAuditLog(req, {
      action: 'CREATE_SCHEDULE',
      entity: 'Schedule',
      entityId: createdSchedule.id,
      details: {
        classId,
        subjectId,
        teacherId,
        dayOfWeek: normalizedDayOfWeek,
        startTime: normalizedStartTime,
        endTime: normalizedEndTime,
      },
    });

    res.status(201).json(createdSchedule);
  } catch (error) {
    res.status(500).json({ error: "Failed" });
  }
});

app.put('/api/schedules/:id', authenticateToken, requireAdmin, async (req: Request, res: Response): Promise<any> => {
  try {
    const scheduleId = req.params.id as string;
    const { classId, subjectId, teacherId, dayOfWeek, startTime, endTime } = req.body;

    if (!classId || !subjectId || !teacherId || !dayOfWeek || !startTime || !endTime) {
      return res.status(400).json({ error: "All fields are required!" });
    }

    const normalizedDayOfWeek = String(dayOfWeek).trim();
    const normalizedStartTime = String(startTime).trim();
    const normalizedEndTime = String(endTime).trim();

    if (!normalizedDayOfWeek) {
      return res.status(400).json({ error: "dayOfWeek is required!" });
    }

    if (!isValidTimeValue(normalizedStartTime) || !isValidTimeValue(normalizedEndTime)) {
      return res.status(400).json({
        error: "startTime and endTime must use HH:MM format!",
      });
    }

    if (normalizedEndTime <= normalizedStartTime) {
      return res.status(400).json({
        error: "endTime must be later than startTime!",
      });
    }

    const existingSchedule = await prisma.schedule.findUnique({
      where: { id: scheduleId }
    });

    if (!existingSchedule) {
      return res.status(404).json({ error: "Schedule not found!" });
    }

    const { classConflict, teacherConflict } = await findScheduleConflicts({
  classId,
  teacherId,
  dayOfWeek: normalizedDayOfWeek,
  startTime: normalizedStartTime,
  endTime: normalizedEndTime,
  excludeScheduleId: scheduleId,
});

if (classConflict) {
  return res.status(409).json({
    error: 'This class already has another schedule that overlaps with this time slot.',
  });
}

if (teacherConflict) {
  return res.status(409).json({
    error: 'This teacher already has another schedule that overlaps with this time slot.',
  });
}

    const updatedSchedule = await prisma.schedule.update({
      where: { id: scheduleId },
      data: {
        classId,
        subjectId,
        teacherId,
        dayOfWeek: normalizedDayOfWeek,
        startTime: normalizedStartTime,
        endTime: normalizedEndTime
      },
      include: {
        class: true,
        subject: true,
        teacher: { include: { user: {
  select: publicUserSelect,
} } }
      }
    });

    await createAuditLog(req, {
      action: 'UPDATE_SCHEDULE',
      entity: 'Schedule',
      entityId: updatedSchedule.id,
      details: {
        classId,
        subjectId,
        teacherId,
        dayOfWeek: normalizedDayOfWeek,
        startTime: normalizedStartTime,
        endTime: normalizedEndTime,
      },
    });

    res.json(updatedSchedule);
  } catch (error) {
    res.status(500).json({ error: "Failed to update schedule" });
  }
});

app.delete('/api/schedules/:id', authenticateToken, requireAdmin, async (req: Request, res: Response): Promise<any> => {
  try {
    const scheduleId = req.params.id as string;

    const scheduleToDelete = await prisma.schedule.findUnique({
      where: { id: scheduleId },
      select: {
        id: true,
        classId: true,
        subjectId: true,
        teacherId: true,
        dayOfWeek: true,
        startTime: true,
        endTime: true,
      },
    });

    if (!scheduleToDelete) {
      return res.status(404).json({ error: "Schedule not found!" });
    }

    await prisma.schedule.delete({ where: { id: scheduleId } });

    await createAuditLog(req, {
      action: 'DELETE_SCHEDULE',
      entity: 'Schedule',
      entityId: scheduleToDelete.id,
      details: scheduleToDelete,
    });

    res.json({ message: "Deleted!" });
  } catch (error) {
    res.status(500).json({ error: "Failed" });
  }
});
app.get('/api/attendance/:scheduleId', authenticateToken, async (req: Request, res: Response): Promise<any> => {
  try {
    const userId = (req as any).user.userId;
    const role = (req as any).user.role;
    const scheduleId = req.params.scheduleId as string;
    const rawDate = req.query.date as string | undefined;

    if (role !== 'ADMIN' && role !== 'TEACHER') {
      return res.status(403).json({ error: 'Only admins and teachers can view attendance.' });
    }

    const schedule = await prisma.schedule.findUnique({
      where: { id: scheduleId },
      select: {
        id: true,
        teacherId: true,
        classId: true,
      },
    });

    if (!schedule) {
      return res.status(404).json({ error: 'Schedule not found!' });
    }

    if (role === 'TEACHER') {
      const teacherId = await getTeacherProfileId(userId);

      if (!teacherId) {
        return res.status(404).json({ error: 'Teacher profile not found!' });
      }

      if (schedule.teacherId !== teacherId) {
        return res.status(403).json({
          error: 'You can only view attendance for your own schedules.',
        });
      }
    }

    if (!rawDate) {
      return res.status(400).json({ error: 'date query parameter is required!' });
    }

    const targetDate = new Date(rawDate);

    if (Number.isNaN(targetDate.getTime())) {
      return res.status(400).json({ error: 'date must be a valid date!' });
    }

    const startDate = new Date(targetDate);
    startDate.setHours(0, 0, 0, 0);

    const endDate = new Date(targetDate);
    endDate.setHours(23, 59, 59, 999);

    const rows = await prisma.attendance.findMany({
      where: {
        scheduleId,
        date: {
          gte: startDate,
          lte: endDate,
        },
      },
    });

    res.json(rows);
  } catch (error) {
    console.error('GET /api/attendance/:scheduleId error:', error);
    res.status(500).json({ error: 'Failed' });
  }
});
app.post('/api/attendance', authenticateToken, async (req: Request, res: Response): Promise<any> => {
  try {
    const userId = (req as any).user.userId;
    const role = (req as any).user.role;
    const { studentId, scheduleId, status, date } = req.body;

    if (role !== 'ADMIN' && role !== 'TEACHER') {
      return res.status(403).json({ error: 'Only admins and teachers can save attendance.' });
    }

    if (!studentId || !scheduleId || !status || !date) {
      return res.status(400).json({
        error: 'studentId, scheduleId, status and date are required!',
      });
    }

    const normalizedStatus = parseAttendanceStatus(status);

    if (!normalizedStatus) {
      return res.status(400).json({
        error: 'status must be PRESENT, ABSENT or LATE!',
      });
    }

    const schedule = await prisma.schedule.findUnique({
      where: { id: scheduleId },
      select: {
        id: true,
        teacherId: true,
        classId: true,
      },
    });

    if (!schedule) {
      return res.status(404).json({ error: 'Schedule not found!' });
    }

    if (role === 'TEACHER') {
      const teacherId = await getTeacherProfileId(userId);

      if (!teacherId) {
        return res.status(404).json({ error: 'Teacher profile not found!' });
      }

      if (schedule.teacherId !== teacherId) {
        return res.status(403).json({
          error: 'You can only save attendance for your own schedules.',
        });
      }
    }

    const student = await prisma.student.findUnique({
      where: { id: studentId },
      select: {
        id: true,
        classId: true,
      },
    });

    if (!student) {
      return res.status(404).json({ error: 'Student not found!' });
    }

    if (student.classId !== schedule.classId) {
      return res.status(400).json({
        error: 'This student does not belong to the class of the selected schedule.',
      });
    }

    const targetDate = new Date(date);

    if (Number.isNaN(targetDate.getTime())) {
      return res.status(400).json({ error: 'date must be a valid date!' });
    }

    const startDate = new Date(targetDate);
    startDate.setHours(0, 0, 0, 0);

    const endDate = new Date(targetDate);
    endDate.setHours(23, 59, 59, 999);

    const existing = await prisma.attendance.findFirst({
      where: {
        studentId,
        scheduleId,
        date: {
          gte: startDate,
          lte: endDate,
        },
      },
    });

    let savedAttendance;

if (existing) {
  savedAttendance = await prisma.attendance.update({
    where: { id: existing.id },
    data: { status: normalizedStatus },
  });
} else {
  savedAttendance = await prisma.attendance.create({
    data: {
      studentId,
      scheduleId,
      status: normalizedStatus,
      date: targetDate,
    },
  });
}

await createAuditLog(req, {
  action: existing ? 'UPDATE_ATTENDANCE' : 'CREATE_ATTENDANCE',
  entity: 'Attendance',
  entityId: savedAttendance.id,
  details: {
    studentId,
    scheduleId,
    status: normalizedStatus,
    date: targetDate.toISOString(),
  },
});

res.json({ message: 'Attendance saved!' });
  } catch (error) {
    console.error('POST /api/attendance error:', error);
    res.status(500).json({ error: 'Failed' });
  }
});
app.get('/api/grades/:classId/:subjectId', authenticateToken, async (req: Request, res: Response): Promise<any> => {
  try {
    const userId = (req as any).user.userId;
    const role = (req as any).user.role;
    const classId = req.params.classId as string;
    const subjectId = req.params.subjectId as string;
    const period = parseGradePeriod(req.query.period as string | undefined);

    if (role !== 'ADMIN' && role !== 'TEACHER') {
      return res.status(403).json({ error: 'Only admins and teachers can view grades.' });
    }

    if (role === 'TEACHER') {
      const teacherId = await getTeacherProfileId(userId);

      if (!teacherId) {
        return res.status(404).json({ error: 'Teacher profile not found!' });
      }

      const allowed = await teacherHasClassSubjectScope(teacherId, classId, subjectId);

      if (!allowed) {
        return res.status(403).json({
          error: 'You can only view grades for your own classes and subjects.',
        });
      }
    }

    const students = await prisma.student.findMany({
  where: { classId },
  include: {
    user: {
      select: publicUserSelect,
    },
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
    res.status(500).json({ error: 'Failed' });
  }
});
app.post('/api/grades', authenticateToken, async (req: Request, res: Response): Promise<any> => {
  try {
    const userId = (req as any).user.userId;
    const role = (req as any).user.role;
    const { studentId, subjectId, examType, period, score, comments } = req.body;

    if (role !== 'ADMIN' && role !== 'TEACHER') {
      return res.status(403).json({ error: 'Only admins and teachers can save grades.' });
    }

    if (!studentId || !subjectId || !examType || score === undefined || score === null) {
      return res.status(400).json({ error: 'studentId, subjectId, examType, and score are required!' });
    }

    const normalizedExamType = String(examType).trim();

    if (!normalizedExamType) {
      return res.status(400).json({ error: 'examType is required!' });
    }

    const studentProfile = await prisma.student.findUnique({
      where: { id: studentId },
      include: {
        user: {
  select: publicUserSelect,
},
        parent: true,
      },
    });

    if (!studentProfile) {
      return res.status(404).json({ error: 'Student not found!' });
    }

    if (!studentProfile.classId) {
      return res.status(400).json({ error: 'Student is not linked to a class.' });
    }

    if (role === 'TEACHER') {
      const teacherId = await getTeacherProfileId(userId);

      if (!teacherId) {
        return res.status(404).json({ error: 'Teacher profile not found!' });
      }

      const allowed = await teacherHasClassSubjectScope(
        teacherId,
        studentProfile.classId,
        subjectId
      );

      if (!allowed) {
        return res.status(403).json({
          error: 'You can only save grades for your own classes and subjects.',
        });
      }
    }

    const gradePeriod = parseGradePeriod(period);
    const numericScore = parseFloat(String(score));

    if (Number.isNaN(numericScore)) {
      return res.status(400).json({ error: 'Score must be a valid number!' });
    }

    if (numericScore < 0 || numericScore > 20) {
      return res.status(400).json({ error: 'Score must be between 0 and 20!' });
    }

    const existing = await prisma.grade.findFirst({
      where: {
        studentId,
        subjectId,
        examType: normalizedExamType,
        period: gradePeriod,
      },
    });

    let savedGrade;

    if (existing) {
      savedGrade = await prisma.grade.update({
        where: { id: existing.id },
        data: {
          score: numericScore,
          comments: comments ? String(comments).trim() : null,
          period: gradePeriod,
        },
      });
    } else {
      savedGrade = await prisma.grade.create({
        data: {
          studentId,
          subjectId,
          examType: normalizedExamType,
          period: gradePeriod,
          score: numericScore,
          comments: comments ? String(comments).trim() : null,
        },
      });
    }

    const subjectInfo = await prisma.subject.findUnique({
      where: { id: subjectId },
    });

    const notificationUserIds = [
      studentProfile.parent?.userId,
    ].filter(Boolean) as string[];

    await createNotificationsForUserIds(
      notificationUserIds,
      'New grade published',
      `A new ${subjectInfo?.name ?? 'subject'} grade (${numericScore}/20) was added for ${gradePeriod}.`,
      'GRADE',
      savedGrade.id
    );

    await createAuditLog(req, {
      action: existing ? 'UPDATE_GRADE' : 'CREATE_GRADE',
      entity: 'Grade',
      entityId: savedGrade.id,
      details: {
    studentId,
    subjectId,
    examType: normalizedExamType,
    period: gradePeriod,
    score: numericScore,
  },
});

    res.json({ message: 'Grade saved!', grade: savedGrade });
  } catch (error) {
    console.error('POST /api/grades error:', error);
    res.status(500).json({ error: 'Failed' });
  }
});

app.get('/api/student-summary/:studentId', authenticateToken, async (req: Request, res: Response): Promise<any> => {
  try {
    const userId = (req as any).user.userId;
    const role = (req as any).user.role;
    const studentId = req.params.studentId as string;
    const period = parseGradePeriod(req.query.period as string | undefined);

    if (role !== 'ADMIN' && role !== 'TEACHER') {
      return res.status(403).json({ error: 'Only admins and teachers can view student summaries.' });
    }

    if (role === 'TEACHER') {
      const teacherId = await getTeacherProfileId(userId);

      if (!teacherId) {
        return res.status(404).json({ error: 'Teacher profile not found!' });
      }

      const { allowed } = await teacherHasStudentScope(teacherId, studentId);

      if (!allowed) {
        return res.status(403).json({
          error: 'You can only view summaries for students in your own scope.',
        });
      }
    }

    const student = await prisma.student.findUnique({
      where: { id: studentId },
      include: {
        user: {
  select: publicUserSelect,
},
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
    const userId = (req as any).user.userId;
    const role = (req as any).user.role;
    const studentId = req.params.studentId as string;
    const period = parseGradePeriod(req.query.period as string | undefined);

    if (role !== 'ADMIN' && role !== 'TEACHER') {
      return res.status(403).json({ error: 'Only admins and teachers can view bulletins.' });
    }

    if (role === 'TEACHER') {
      const teacherId = await getTeacherProfileId(userId);

      if (!teacherId) {
        return res.status(404).json({ error: 'Teacher profile not found!' });
      }

      const { allowed } = await teacherHasStudentScope(teacherId, studentId);

      if (!allowed) {
        return res.status(403).json({
          error: 'You can only view bulletins for students in your own scope.',
        });
      }
    }

    const student = await prisma.student.findUnique({
  where: { id: studentId },
  include: {
    user: {
      select: publicUserSelect,
    },
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

// REPORTS
app.get('/api/reports/attendance', authenticateToken, async (req: Request, res: Response): Promise<any> => {
  try {
    const role = (req as any).user.role;

    if (role !== 'ADMIN') {
      return res.status(403).json({ error: 'Only admins can access attendance reports.' });
    }

    const classId = req.query.classId as string | undefined;
    const from = req.query.from as string | undefined;
    const to = req.query.to as string | undefined;

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
    user: {
      select: publicUserSelect,
    },
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

    const rowsByStudent = new Map<
      string,
      {
        studentId: string;
        studentName: string;
        email: string;
        present: number;
        absent: number;
        late: number;
        total: number;
        absenceRate: number;
      }
    >();

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

      if (!row) continue;

      row.total += 1;

      if (attendance.status === 'PRESENT') row.present += 1;
      else if (attendance.status === 'ABSENT') row.absent += 1;
      else if (attendance.status === 'LATE') row.late += 1;
    }

    const rows = Array.from(rowsByStudent.values()).map((row) => ({
      ...row,
      absenceRate:
        row.total > 0 ? Math.round((row.absent / row.total) * 100) : 0,
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
  } catch (error) {
    console.error('GET /api/reports/attendance error:', error);
    res.status(500).json({ error: 'Failed to generate attendance report.' });
  }
});

// REPORTS - GRADES
app.get('/api/reports/grades', authenticateToken, async (req: Request, res: Response): Promise<any> => {
  try {
    const role = (req as any).user.role;

    if (role !== 'ADMIN') {
      return res.status(403).json({ error: 'Only admins can access grades reports.' });
    }

    const classId = req.query.classId as string | undefined;
    const subjectId = req.query.subjectId as string | undefined;
    const period = parseGradePeriod(req.query.period as string | undefined);

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

      const average =
        scores.length > 0
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
      .filter((value): value is number => value !== null);

    const classAverage =
      averages.length > 0
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
  } catch (error) {
    console.error('GET /api/reports/grades error:', error);
    res.status(500).json({ error: 'Failed to generate grades report.' });
  }
});

// ASSIGNMENTS
app.get('/api/assignments', authenticateToken, async (req: Request, res: Response): Promise<any> => {
  try {
    if (!isAdminOrTeacher(req)) {
      return res.status(403).json({ error: 'Only admins and teachers can view assignments.' });
    }

    const userId = (req as any).user.userId;
    const role = (req as any).user.role;
    const classId = req.query.classId as string | undefined;
    const subjectId = req.query.subjectId as string | undefined;

    let teacherIdFilter: string | undefined;

    if (role === 'TEACHER') {
      const teacherId = await getTeacherProfileId(userId);

      if (!teacherId) {
        return res.status(404).json({ error: 'Teacher profile not found!' });
      }

      teacherIdFilter = teacherId;
    }

    const assignments = await prisma.assignment.findMany({
      where: {
        ...(classId ? { classId } : {}),
        ...(subjectId ? { subjectId } : {}),
        ...(teacherIdFilter ? { teacherId: teacherIdFilter } : {}),
      },
      include: {
        class: true,
        subject: true,
        teacher: {
  include: {
    user: {
      select: publicUserSelect,
    },
  },
},
        _count: { select: { submissions: true } },
      },
      orderBy: { dueDate: 'asc' },
    });

    res.json(assignments);
  } catch (error) {
    console.error('GET /api/assignments error:', error);
    res.status(500).json({ error: 'Failed to fetch assignments' });
  }
});

app.post('/api/assignments', authenticateToken, async (req: Request, res: Response): Promise<any> => {
  try {
    if (!isAdminOrTeacher(req)) {
      return res.status(403).json({ error: 'Only admins and teachers can create assignments.' });
    }

    const userId = (req as any).user.userId;
    const role = (req as any).user.role;
    const { classId, subjectId, teacherId, title, description, dueDate } = req.body;

    if (!classId || !subjectId || !title || !dueDate) {
      return res.status(400).json({ error: 'classId, subjectId, title and dueDate are required!' });
    }

    const parsedDueDate = new Date(String(dueDate));

    if (Number.isNaN(parsedDueDate.getTime())) {
      return res.status(400).json({ error: 'dueDate must be a valid date!' });
    }

    const selectedClass = await prisma.class.findUnique({
      where: { id: classId },
      select: { id: true },
    });

    if (!selectedClass) {
      return res.status(400).json({ error: 'Selected class does not exist!' });
    }

    const selectedSubject = await prisma.subject.findUnique({
      where: { id: subjectId },
      select: { id: true },
    });

    if (!selectedSubject) {
      return res.status(400).json({ error: 'Selected subject does not exist!' });
    }

    let resolvedTeacherId: string | null =
      teacherId === undefined || teacherId === null || String(teacherId).trim() === ''
        ? null
        : String(teacherId).trim();

    if (role === 'TEACHER') {
      const teacherIdFromToken = await getTeacherProfileId(userId);

      if (!teacherIdFromToken) {
        return res.status(404).json({ error: 'Teacher profile not found!' });
      }

      const ownsScope = await prisma.schedule.findFirst({
        where: {
          teacherId: teacherIdFromToken,
          classId,
          subjectId,
        },
        select: { id: true },
      });

      if (!ownsScope) {
        return res.status(403).json({
          error: 'You can only create assignments for your own classes and subjects.',
        });
      }

      resolvedTeacherId = teacherIdFromToken;
    }

    if (role === 'ADMIN') {
  if (!resolvedTeacherId) {
    return res.status(400).json({
      error: 'teacherId is required when an admin creates an assignment.',
    });
  }

  const teacherScope = await prisma.schedule.findFirst({
    where: {
      teacherId: resolvedTeacherId,
      classId,
      subjectId,
    },
    select: { id: true },
  });

  if (!teacherScope) {
    return res.status(400).json({
      error: 'Selected teacher is not scheduled for this class and subject.',
    });
  }
}

    const created = await prisma.assignment.create({
      data: {
        classId,
        subjectId,
        teacherId: resolvedTeacherId,
        title: String(title).trim(),
        description: description ? String(description).trim() : null,
        dueDate: parsedDueDate,
      },
      include: {
        class: true,
        subject: true,
        teacher: { include: { user: {
  select: publicUserSelect,
} } },
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
        user: {
  select: publicUserSelect,
},
        parent: {
          include: {
            user: {
  select: publicUserSelect,
},
          },
        },
      },
    });

    const notificationUserIds = [
      ...studentProfiles.map((student) => student.userId),
      ...studentProfiles
        .map((student) => student.parent?.userId)
        .filter(Boolean) as string[],
    ];

    await createNotificationsForUserIds(
      notificationUserIds,
      'New assignment',
      `${String(title).trim()} has been assigned with due date ${parsedDueDate.toLocaleString()}.`,
      'ASSIGNMENT',
      created.id
    );

    await createAuditLog(req, {
      action: 'CREATE_ASSIGNMENT',
      entity: 'Assignment',
      entityId: created.id,
      details: {
        title: created.title,
        classId,
        subjectId,
        teacherId: resolvedTeacherId,
        dueDate: parsedDueDate.toISOString(),
      },
    });

    res.status(201).json(created);
  } catch (error) {
    console.error('POST /api/assignments error:', error);
    res.status(500).json({ error: 'Failed to create assignment' });
  }
});

app.put('/api/assignments/:id', authenticateToken, async (req: Request, res: Response): Promise<any> => {
  try {
    if (!isAdminOrTeacher(req)) {
      return res.status(403).json({ error: 'Only admins and teachers can update assignments.' });
    }

    const userId = (req as any).user.userId;
    const role = (req as any).user.role;
    const assignmentId = req.params.id as string;
    const { title, description, dueDate } = req.body;

    const existing = await prisma.assignment.findUnique({
      where: { id: assignmentId },
      select: {
        id: true,
        teacherId: true,
      },
    });

    if (!existing) {
      return res.status(404).json({ error: 'Assignment not found!' });
    }

    if (role === 'TEACHER') {
      const teacherId = await getTeacherProfileId(userId);

      if (!teacherId) {
        return res.status(404).json({ error: 'Teacher profile not found!' });
      }

      if (existing.teacherId !== teacherId) {
        return res.status(403).json({
          error: 'You can only update your own assignments.',
        });
      }
    }

    let parsedDueDate: Date | undefined = undefined;

    if (dueDate !== undefined && dueDate !== null && dueDate !== '') {
      parsedDueDate = new Date(String(dueDate));

      if (Number.isNaN(parsedDueDate.getTime())) {
        return res.status(400).json({ error: 'dueDate must be a valid date!' });
      }
    }

    const updated = await prisma.assignment.update({
      where: { id: assignmentId },
      data: {
        title: title !== undefined ? String(title).trim() : undefined,
        description: description !== undefined ? (description ? String(description).trim() : null) : undefined,
        dueDate: parsedDueDate,
      },
      include: {
        class: true,
        subject: true,
        teacher: { include: { user: {
  select: publicUserSelect,
} } },
      },
    });

    await createAuditLog(req, {
      action: 'UPDATE_ASSIGNMENT',
      entity: 'Assignment',
      entityId: updated.id,
      details: {
        title: updated.title,
        classId: updated.classId,
        subjectId: updated.subjectId,
        teacherId: updated.teacherId,
        dueDate: updated.dueDate.toISOString(),
      },
    });

    res.json(updated);
  } catch (error) {
    console.error('PUT /api/assignments/:id error:', error);
    res.status(500).json({ error: 'Failed to update assignment' });
  }
});

app.delete('/api/assignments/:id', authenticateToken, async (req: Request, res: Response): Promise<any> => {
  try {
    if (!isAdminOrTeacher(req)) {
      return res.status(403).json({ error: 'Only admins and teachers can delete assignments.' });
    }

    const userId = (req as any).user.userId;
    const role = (req as any).user.role;
    const assignmentId = req.params.id as string;

    const existing = await prisma.assignment.findUnique({
      where: { id: assignmentId },
      select: {
        id: true,
        title: true,
        classId: true,
        subjectId: true,
        teacherId: true,
        dueDate: true,
      },
    });

    if (!existing) {
      return res.status(404).json({ error: 'Assignment not found!' });
    }

    if (role === 'TEACHER') {
      const teacherId = await getTeacherProfileId(userId);

      if (!teacherId) {
        return res.status(404).json({ error: 'Teacher profile not found!' });
      }

      if (existing.teacherId !== teacherId) {
        return res.status(403).json({
          error: 'You can only delete your own assignments.',
        });
      }
    }

    await prisma.assignment.delete({
      where: { id: assignmentId },
    });

    await createAuditLog(req, {
      action: 'DELETE_ASSIGNMENT',
      entity: 'Assignment',
      entityId: existing.id,
      details: {
        title: existing.title,
        classId: existing.classId,
        subjectId: existing.subjectId,
        teacherId: existing.teacherId,
        dueDate: existing.dueDate.toISOString(),
      },
    });

    res.json({ message: 'Assignment deleted!' });
  } catch (error) {
    console.error('DELETE /api/assignments/:id error:', error);
    res.status(500).json({ error: 'Failed to delete assignment' });
  }
});

app.get('/api/my-assignments', authenticateToken, async (req: Request, res: Response): Promise<any> => {
  try {
    const userId = (req as any).user.userId;
    const role = (req as any).user.role;


    if (role === 'PARENT') {
      const parent = await prisma.parent.findUnique({
        where: { userId },
        include: {
          children: {
            include: {
              user: {
  select: publicUserSelect,
},
              submissions: {
                include: {
                  assignment: {
                    include: {
                      class: true,
                      subject: true,
                      teacher: { include: { user: {
  select: publicUserSelect,
} } },
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
        submissions: [...child.submissions].sort(
          (a, b) =>
            new Date(a.assignment.dueDate).getTime() -
            new Date(b.assignment.dueDate).getTime()
        ),
      }));

      return res.json(children);
    }

    return res.status(403).json({
      error: 'Only parents can view student assignments.',
    });
  } catch (error) {
    console.error('GET /api/my-assignments error:', error);
    res.status(500).json({ error: 'Failed to fetch assignments' });
  }
});

app.put('/api/assignment-submissions/:id', authenticateToken, async (req: Request, res: Response): Promise<any> => {
  try {
    const userId = (req as any).user.userId;
    const role = (req as any).user.role;
    const submissionId = req.params.id as string;
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

    if (role !== 'PARENT') {
      return res.status(403).json({
        error: 'Only parents can update assignment submissions for their children.',
      });
    }

    const parent = await prisma.parent.findUnique({
      where: { userId },
    });

    if (!parent || submission.student.parentId !== parent.id) {
      return res.status(403).json({
        error: 'You can only update your child assignments.',
      });
    }

    const normalizedStatus = parseAssignmentStatus(status);

    if (!normalizedStatus) {
      return res.status(400).json({
        error: 'status must be PENDING or DONE!',
      });
    }
    const normalizedNotes =
      notes === undefined || notes === null ? null : String(notes).trim();

    const updated = await prisma.assignmentSubmission.update({
      where: { id: submissionId },
      data: {
        status: normalizedStatus,
        notes: normalizedNotes || null,
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
            user: {
  select: publicUserSelect,
},
          },
        },
      },
    });

    res.json(updated);
  } catch (error) {
    console.error('PUT /api/assignment-submissions/:id error:', error);
    res.status(500).json({ error: 'Failed to update assignment submission' });
  }
});

// ANNOUNCEMENTS
app.get('/api/announcements', authenticateToken, async (req: Request, res: Response): Promise<any> => {
  try {
    if (!isAdminOrTeacher(req)) {
      return res.status(403).json({ error: 'Only admins and teachers can view announcements.' });
    }

    const userId = (req as any).user.userId;
    const role = (req as any).user.role;

    let whereClause: any = undefined;

    if (role === 'TEACHER') {
      const teacherId = await getTeacherProfileId(userId);

      if (!teacherId) {
        return res.status(404).json({ error: 'Teacher profile not found!' });
      }

      const classIds = await getTeacherClassIds(teacherId);

      whereClause = {
        OR: [
          { audience: AnnouncementAudience.ALL },
          { audience: AnnouncementAudience.TEACHERS },
          ...(classIds.length > 0
            ? [{ audience: AnnouncementAudience.CLASS, classId: { in: classIds } }]
            : []),
        ],
      };
    }

    const announcements = await prisma.announcement.findMany({
      where: whereClause,
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
  } catch (error) {
    console.error('GET /api/announcements error:', error);
    res.status(500).json({ error: 'Failed to fetch announcements' });
  }
});

app.post('/api/announcements', authenticateToken, async (req: Request, res: Response): Promise<any> => {
  try {
    if (!isAdminOrTeacher(req)) {
      return res.status(403).json({ error: 'Only admins and teachers can create announcements.' });
    }

    const userId = (req as any).user.userId;
    const role = (req as any).user.role;

    const normalizedTitle = String(req.body.title ?? '').trim();
    const normalizedContent = String(req.body.content ?? '').trim();
    const normalizedClassId =
      req.body.classId === undefined || req.body.classId === null || req.body.classId === ''
        ? null
        : String(req.body.classId).trim();

    if (!normalizedTitle || !normalizedContent) {
      return res.status(400).json({ error: 'title and content are required!' });
    }

    const parsedAudience = parseAnnouncementAudience(req.body.audience);
    const allowedAudiences = getAllowedAnnouncementAudiences(role);

    if (!allowedAudiences.includes(parsedAudience)) {
      return res.status(403).json({
        error: 'You are not allowed to create announcements for this audience.',
      });
    }

    if (parsedAudience === AnnouncementAudience.CLASS && !normalizedClassId) {
      return res.status(400).json({ error: 'classId is required when audience is CLASS.' });
    }

    if (role === 'TEACHER' && parsedAudience === AnnouncementAudience.CLASS) {
      const teacherId = await getTeacherProfileId(userId);

      if (!teacherId) {
        return res.status(404).json({ error: 'Teacher profile not found!' });
      }

      const classIds = await getTeacherClassIds(teacherId);

      if (!normalizedClassId || !classIds.includes(normalizedClassId)) {
        return res.status(403).json({
          error: 'You can only create class announcements for your own classes.',
        });
      }
    }

    const created = await prisma.announcement.create({
      data: {
        title: normalizedTitle,
        content: normalizedContent,
        audience: parsedAudience,
        classId: parsedAudience === AnnouncementAudience.CLASS ? normalizedClassId : null,
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

    let notificationUserIds: string[] = [];

    if (parsedAudience === AnnouncementAudience.ALL) {
      const users = await prisma.user.findMany({
        where: {
          role: {
            not: Role.STUDENT,
          },
        },
        select: { id: true },
      });

      notificationUserIds = users.map((user) => user.id);
    } else if (parsedAudience === AnnouncementAudience.STUDENTS) {
      const parents = await prisma.parent.findMany({
        select: { userId: true },
      });

      notificationUserIds = parents.map((parent) => parent.userId);
    } else if (parsedAudience === AnnouncementAudience.PARENTS) {
      const users = await prisma.user.findMany({
        where: { role: Role.PARENT },
        select: { id: true },
      });

      notificationUserIds = users.map((user) => user.id);
    } else if (parsedAudience === AnnouncementAudience.TEACHERS) {
      const users = await prisma.user.findMany({
        where: { role: Role.TEACHER },
        select: { id: true },
      });

      notificationUserIds = users.map((user) => user.id);
    } else if (parsedAudience === AnnouncementAudience.CLASS && normalizedClassId) {
      const students = await prisma.student.findMany({
        where: { classId: normalizedClassId },
        include: {
          parent: true,
        },
      });

      notificationUserIds = students
        .map((student) => student.parent?.userId)
        .filter(Boolean) as string[];
    }

    await createNotificationsForUserIds(
      notificationUserIds,
      'New announcement',
      normalizedTitle,
      'ANNOUNCEMENT',
      created.id
    );

    await createAuditLog(req, {
      action: 'CREATE_ANNOUNCEMENT',
      entity: 'Announcement',
      entityId: created.id,
      details: {
        title: created.title,
        audience: created.audience,
        classId: created.classId,
        createdById: userId,
      },
    });

    res.status(201).json(created);
  } catch (error) {
    console.error('POST /api/announcements error:', error);
    res.status(500).json({ error: 'Failed to create announcement' });
  }
});

app.put('/api/announcements/:id', authenticateToken, async (req: Request, res: Response): Promise<any> => {
  try {
    if (!isAdminOrTeacher(req)) {
      return res.status(403).json({ error: 'Only admins and teachers can update announcements.' });
    }

    const role = (req as any).user.role;
    const announcementId = req.params.id as string;

    const normalizedTitle = String(req.body.title ?? '').trim();
    const normalizedContent = String(req.body.content ?? '').trim();
    const normalizedClassId =
      req.body.classId === undefined || req.body.classId === null || req.body.classId === ''
        ? null
        : String(req.body.classId).trim();

    const existing = await prisma.announcement.findUnique({
      where: { id: announcementId },
    });

    if (!existing) {
      return res.status(404).json({ error: 'Announcement not found!' });
    }

    if (role === 'TEACHER') {
      return res.status(403).json({
        error: 'Teachers cannot edit announcements from this page.',
      });
    }

    if (!normalizedTitle || !normalizedContent) {
      return res.status(400).json({ error: 'title and content are required!' });
    }

    const parsedAudience = parseAnnouncementAudience(req.body.audience);

    if (parsedAudience === AnnouncementAudience.CLASS && !normalizedClassId) {
      return res.status(400).json({ error: 'classId is required when audience is CLASS.' });
    }

    const updated = await prisma.announcement.update({
      where: { id: announcementId },
      data: {
        title: normalizedTitle,
        content: normalizedContent,
        audience: parsedAudience,
        classId: parsedAudience === AnnouncementAudience.CLASS ? normalizedClassId : null,
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

    await createAuditLog(req, {
      action: 'UPDATE_ANNOUNCEMENT',
      entity: 'Announcement',
      entityId: updated.id,
      details: {
        title: updated.title,
        audience: updated.audience,
        classId: updated.classId,
      },
    });

    res.json(updated);
  } catch (error) {
    console.error('PUT /api/announcements/:id error:', error);
    res.status(500).json({ error: 'Failed to update announcement' });
  }
});

app.delete('/api/announcements/:id', authenticateToken, requireAdmin, async (req: Request, res: Response): Promise<any> => {
  try {
    const announcementId = req.params.id as string;

    const announcementToDelete = await prisma.announcement.findUnique({
      where: { id: announcementId },
      select: {
        id: true,
        title: true,
        audience: true,
        classId: true,
        createdById: true,
      },
    });

    if (!announcementToDelete) {
      return res.status(404).json({ error: 'Announcement not found!' });
    }

    await prisma.announcement.delete({
      where: { id: announcementId },
    });

    await createAuditLog(req, {
      action: 'DELETE_ANNOUNCEMENT',
      entity: 'Announcement',
      entityId: announcementToDelete.id,
      details: {
        title: announcementToDelete.title,
        audience: announcementToDelete.audience,
        classId: announcementToDelete.classId,
        createdById: announcementToDelete.createdById,
      },
    });

    res.json({ message: 'Announcement deleted!' });
  } catch (error) {
    res.status(500).json({ error: 'Failed to delete announcement' });
  }
});

app.get('/api/my-announcements', authenticateToken, async (req: Request, res: Response): Promise<any> => {
  try {
    const userId = (req as any).user.userId;
    const role = (req as any).user.role;


    if (role === 'PARENT') {
      const parent = await prisma.parent.findUnique({
        where: { userId },
        include: { children: true },
      });

      const classIds = (parent?.children ?? [])
        .map((child) => child.classId)
        .filter(Boolean) as string[];

      const announcements = await prisma.announcement.findMany({
  where: {
    OR: [
      { audience: AnnouncementAudience.ALL },
      { audience: AnnouncementAudience.PARENTS },
      { audience: AnnouncementAudience.STUDENTS },
      ...(classIds.length > 0
        ? [{ audience: AnnouncementAudience.CLASS, classId: { in: classIds } }]
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
  const teacherId = await getTeacherProfileId(userId);

  if (!teacherId) {
    return res.status(404).json({ error: 'Teacher profile not found!' });
  }

  const classIds = await getTeacherClassIds(teacherId);

  const announcements = await prisma.announcement.findMany({
    where: {
      OR: [
        { audience: AnnouncementAudience.ALL },
        { audience: AnnouncementAudience.TEACHERS },
        ...(classIds.length > 0
          ? [{ audience: AnnouncementAudience.CLASS, classId: { in: classIds } }]
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

    return res.status(403).json({ error: 'Role not allowed for announcements.' });
  } catch (error) {
    console.error('GET /api/my-announcements error:', error);
    res.status(500).json({ error: 'Failed to fetch announcements' });
  }
});

// NOTIFICATIONS
app.get('/api/my-notifications', authenticateToken, async (req: Request, res: Response): Promise<any> => {
  try {
    const userId = (req as any).user.userId;

    const notifications = await prisma.notification.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
    });

    res.json(notifications);
  } catch (error) {
    console.error('GET /api/my-notifications error:', error);
    res.status(500).json({ error: 'Failed to fetch notifications' });
  }
});

app.put('/api/notifications/:id/read', authenticateToken, async (req: Request, res: Response): Promise<any> => {
  try {
    const userId = (req as any).user.userId;
    const notificationId = req.params.id as string;

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
  } catch (error) {
    console.error('PUT /api/notifications/:id/read error:', error);
    res.status(500).json({ error: 'Failed to update notification' });
  }
});

app.post('/api/notify-bulletin/:studentId', authenticateToken, async (req: Request, res: Response): Promise<any> => {
  try {
    if (!isAdminOrTeacher(req)) {
      return res.status(403).json({ error: 'Only admins and teachers can publish bulletin notifications.' });
    }

    const userId = (req as any).user.userId;
    const role = (req as any).user.role;
    const studentId = req.params.studentId as string;
    const period = parseGradePeriod(req.body?.period);

    if (role === 'TEACHER') {
      const teacherId = await getTeacherProfileId(userId);

      if (!teacherId) {
        return res.status(404).json({ error: 'Teacher profile not found!' });
      }

      const { allowed } = await teacherHasStudentScope(teacherId, studentId);

      if (!allowed) {
        return res.status(403).json({
          error: 'You can only notify bulletins for students in your own scope.',
        });
      }
    }

    const student = await prisma.student.findUnique({
      where: { id: studentId },
      include: {
        user: {
  select: publicUserSelect,
},
        parent: true,
      },
    });

    if (!student) {
      return res.status(404).json({ error: 'Student not found!' });
    }

    const notificationUserIds = [
      student.parent?.userId,
    ].filter(Boolean) as string[];

    await createNotificationsForUserIds(
      notificationUserIds,
      'Bulletin available',
      `Your ${period} bulletin is now available.`,
      'BULLETIN',
      studentId
    );

    res.json({ message: 'Bulletin notification sent!' });
  } catch (error) {
    console.error('POST /api/notify-bulletin/:studentId error:', error);
    res.status(500).json({ error: 'Failed to send bulletin notification' });
  }
});

app.get('/api/my-teacher-overview', authenticateToken, async (req: Request, res: Response): Promise<any> => {
  try {
    const userId = (req as any).user.userId;
    const role = (req as any).user.role;

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

    const teacherClassIds = uniqueStringValues(
  teacher.schedules.map((schedule) => schedule.classId)
);

const announcements = await prisma.announcement.findMany({
  where: {
    OR: [
      { audience: AnnouncementAudience.ALL },
      { audience: AnnouncementAudience.TEACHERS },
      ...(teacherClassIds.length > 0
        ? [{ audience: AnnouncementAudience.CLASS, classId: { in: teacherClassIds } }]
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
  } catch (error) {
    console.error('GET /api/my-teacher-overview error:', error);
    res.status(500).json({ error: 'Failed to fetch teacher overview' });
  }
});

// MESSAGES
app.get('/api/messages/recipients', authenticateToken, async (req: Request, res: Response): Promise<any> => {
  try {
    const userId = (req as any).user.userId;
    const role = (req as any).user.role;

    const recipients = await getAllowedMessageRecipients(userId, role);

    res.json(recipients);
  } catch (error) {
    console.error('GET /api/messages/recipients error:', error);
    res.status(500).json({ error: 'Failed to fetch message recipients.' });
  }
});

app.get('/api/messages/conversations', authenticateToken, async (req: Request, res: Response): Promise<any> => {
  try {
    const userId = (req as any).user.userId;

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

    const conversationsWithUnread = await Promise.all(
      conversations.map(async (conversation) => {
        const currentParticipant = conversation.participants.find(
          (participant) => participant.userId === userId
        );

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
      })
    );

    res.json(conversationsWithUnread);
  } catch (error) {
    console.error('GET /api/messages/conversations error:', error);
    res.status(500).json({ error: 'Failed to fetch conversations.' });
  }
});

app.get('/api/messages/conversations/:id', authenticateToken, async (req: Request, res: Response): Promise<any> => {
  try {
    const userId = (req as any).user.userId;
    const conversationId = req.params.id as string;

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
  } catch (error) {
    console.error('GET /api/messages/conversations/:id error:', error);
    res.status(500).json({ error: 'Failed to fetch conversation.' });
  }
});

app.post('/api/messages/conversations', authenticateToken, async (req: Request, res: Response): Promise<any> => {
  try {
    const userId = (req as any).user.userId;
    const role = (req as any).user.role;
    const { title, participantIds, message } = req.body;

    const cleanParticipantIds = Array.isArray(participantIds)
      ? uniqueStringValues(
          participantIds.filter((participantId) => typeof participantId === 'string')
        ).filter((participantId) => participantId !== userId)
      : [];

    const cleanMessage =
      typeof message === 'string' && message.trim()
        ? message.trim()
        : '';

    if (cleanParticipantIds.length === 0) {
      return res.status(400).json({ error: 'At least one participant is required.' });
    }

    const allowedRecipients = await getAllowedMessageRecipients(userId, role);
    const allowedRecipientIds = new Set(allowedRecipients.map((user) => user.id));

    const forbiddenParticipantIds = cleanParticipantIds.filter(
      (participantId) => !allowedRecipientIds.has(participantId)
    );

    if (forbiddenParticipantIds.length > 0) {
      return res.status(403).json({
        error: 'You are not allowed to start a conversation with one or more selected users.',
      });
    }

    const allParticipantIds = uniqueStringValues([userId, ...cleanParticipantIds]);
    const now = new Date();

    const createdConversation = await prisma.conversation.create({
      data: {
        title:
          typeof title === 'string' && title.trim()
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

      await createNotificationsForUserIds(
        cleanParticipantIds,
        'New message',
        cleanMessage.length > 120 ? `${cleanMessage.slice(0, 120)}...` : cleanMessage,
        'MESSAGE',
        createdConversation.id
      );
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
  } catch (error) {
    console.error('POST /api/messages/conversations error:', error);
    res.status(500).json({ error: 'Failed to create conversation.' });
  }
});

app.post('/api/messages/conversations/:id/messages', authenticateToken, async (req: Request, res: Response): Promise<any> => {
  try {
    const userId = (req as any).user.userId;
    const conversationId = req.params.id as string;
    const { body } = req.body;

    const cleanBody =
      typeof body === 'string' && body.trim()
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

    await createNotificationsForUserIds(
      recipientUserIds,
      'New message',
      cleanBody.length > 120 ? `${cleanBody.slice(0, 120)}...` : cleanBody,
      'MESSAGE',
      conversationId
    );

    res.status(201).json(createdMessage);
  } catch (error) {
    console.error('POST /api/messages/conversations/:id/messages error:', error);
    res.status(500).json({ error: 'Failed to send message.' });
  }
});

app.put('/api/messages/conversations/:id/read', authenticateToken, async (req: Request, res: Response): Promise<any> => {
  try {
    const userId = (req as any).user.userId;
    const conversationId = req.params.id as string;

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
  } catch (error) {
    console.error('PUT /api/messages/conversations/:id/read error:', error);
    res.status(500).json({ error: 'Failed to mark conversation as read.' });
  }
});

// --- PARENT PORTAL ---
app.get('/api/my-portal', authenticateToken, async (req: Request, res: Response): Promise<any> => {
  try {
    const userId = (req as any).user.userId;
    const role = (req as any).user.role;
 
    if (role === 'PARENT') {
      // Find the parent and grab THEIR CHILD's info!
      const parentInfo = await prisma.parent.findUnique({
  where: { userId: userId },
  include: {
    children: {
      include: {
        user: {
          select: publicUserSelect,
        },
        class: {
          include: {
            schedules: {
              include: {
                subject: true,
                teacher: {
                  include: {
                    user: {
                      select: publicUserSelect,
                    },
                  },
                },
              },
            },
          },
        },
        grades: {
          include: { subject: true },
          orderBy: { createdAt: 'desc' },
        },
        attendances: {
          include: {
            schedule: {
              include: { subject: true },
            },
          },
          orderBy: { date: 'desc' },
        },
      },
    },
  },
});
      return res.json(parentInfo);
    }
    
    res.status(403).json({
      error: 'Only parents can access the parent portal.',
    });
  } catch (error) {
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

const parseNullableDateInput = (value: unknown) => {
  if (value === undefined) return undefined;
  if (value === null || value === "") return null;

  const date = new Date(String(value));

  if (Number.isNaN(date.getTime())) {
    return "INVALID_DATE";
  }

  return date;
};

// SCHOOL SETTINGS
app.get(
  "/api/settings/school",
  authenticateToken,
  async (req: Request, res: Response): Promise<any> => {
    try {
      const settings = await getOrCreateSchoolSettings();
      res.json(settings);
    } catch (error) {
      console.error("GET /api/settings/school error:", error);
      res.status(500).json({ error: "Failed to fetch school settings." });
    }
  }
);

app.put(
  "/api/settings/school",
  authenticateToken,
  async (req: Request, res: Response): Promise<any> => {
    try {
      const role = (req as any).user.role;

      if (role !== "ADMIN") {
        return res.status(403).json({
          error: "Only admins can update school settings.",
        });
      }

      const existingSettings = await getOrCreateSchoolSettings();

      const {
        schoolName,
        schoolSubtitle,
        academicYear,
        defaultTrimester,
        defaultReportFrom,
        defaultReportTo,
      } = req.body;

      const parsedDefaultReportFrom = parseNullableDateInput(defaultReportFrom);
      const parsedDefaultReportTo = parseNullableDateInput(defaultReportTo);

      if (
        parsedDefaultReportFrom === "INVALID_DATE" ||
        parsedDefaultReportTo === "INVALID_DATE"
      ) {
        return res.status(400).json({
          error: "defaultReportFrom and defaultReportTo must be valid dates.",
        });
      }

      const updatedSettings = await prisma.schoolSettings.update({
        where: {
          id: existingSettings.id,
        },
        data: {
          schoolName:
            typeof schoolName === "string" && schoolName.trim()
              ? schoolName.trim()
              : existingSettings.schoolName,

          schoolSubtitle:
            typeof schoolSubtitle === "string" && schoolSubtitle.trim()
              ? schoolSubtitle.trim()
              : existingSettings.schoolSubtitle,

          academicYear:
            typeof academicYear === "string" && academicYear.trim()
              ? academicYear.trim()
              : existingSettings.academicYear,

          defaultTrimester:
            typeof defaultTrimester === "string"
              ? parseGradePeriod(defaultTrimester)
              : existingSettings.defaultTrimester,

          defaultReportFrom:
            parsedDefaultReportFrom === undefined
              ? existingSettings.defaultReportFrom
              : parsedDefaultReportFrom,

          defaultReportTo:
            parsedDefaultReportTo === undefined
              ? existingSettings.defaultReportTo
              : parsedDefaultReportTo,
        },
      });

      await createAuditLog(req, {
  action: 'UPDATE_SCHOOL_SETTINGS',
  entity: 'SchoolSettings',
  entityId: updatedSettings.id,
  details: {
    before: {
      schoolName: existingSettings.schoolName,
      schoolSubtitle: existingSettings.schoolSubtitle,
      academicYear: existingSettings.academicYear,
      defaultTrimester: existingSettings.defaultTrimester,
      defaultReportFrom: existingSettings.defaultReportFrom
        ? existingSettings.defaultReportFrom.toISOString()
        : null,
      defaultReportTo: existingSettings.defaultReportTo
        ? existingSettings.defaultReportTo.toISOString()
        : null,
    },
    after: {
      schoolName: updatedSettings.schoolName,
      schoolSubtitle: updatedSettings.schoolSubtitle,
      academicYear: updatedSettings.academicYear,
      defaultTrimester: updatedSettings.defaultTrimester,
      defaultReportFrom: updatedSettings.defaultReportFrom
        ? updatedSettings.defaultReportFrom.toISOString()
        : null,
      defaultReportTo: updatedSettings.defaultReportTo
        ? updatedSettings.defaultReportTo.toISOString()
        : null,
    },
  },
});

      res.json(updatedSettings);
    } catch (error) {
      console.error("PUT /api/settings/school error:", error);
      res.status(500).json({ error: "Failed to update school settings." });
    }
  }
);

app.listen(PORT, () => console.log(`ðŸš€ Server is running on http://localhost:${PORT}`));