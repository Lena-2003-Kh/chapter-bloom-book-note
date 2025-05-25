import express from "express";
import bodyParser from "body-parser";
import pg from "pg";
import axios from "axios";
import bcrypt from "bcrypt";
import passport from "passport";
import { Strategy } from "passport-local";
import session from "express-session";
import env from "dotenv";
import pgSession from "connect-pg-simple";
import GoogleStrategy from "passport-google-oauth2";
import path from 'path';
import { fileURLToPath } from 'url';
import flash from "connect-flash";
const PgSessionStore = pgSession(session);
const app = express();
const port = 3000;
const saltRounds = 12;
env.config();


const db = new pg.Client({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL && process.env.DATABASE_URL.includes("vercel.com")
      ? { rejectUnauthorized: false }
      : false  // Disable SSL if not required (this is for hosting on platforms like Render)
});
db.connect();


app.use(
  session({
    store: new PgSessionStore({
      pool: db,
      tableName: "sessions",
    }),
    secret: process.env.SESSION_SECRET,
    resave: true,
    saveUninitialized: true,
    cookie: { maxAge: 1000 * 60 * 60 * 24 },
  })
);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

app.use(bodyParser.urlencoded({ extended: true }));
// Serve static files from "public" directory
app.use(express.static(path.join(__dirname, 'public')));
app.use(passport.initialize());
app.use(passport.session());
// These lines create __dirname
app.use(flash());

// View engine setup
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

app.get("/", async (req, res) => {
  try {
    const result = await db.query(`
      SELECT books.*, users.username,
        COALESCE(AVG(book_ratings.rating), 0) AS average_rating
      FROM books
      LEFT JOIN users ON books.user_id = users.id
      LEFT JOIN book_ratings ON books.id = book_ratings.book_id
      WHERE shared = TRUE
      GROUP BY books.id, users.username
      ORDER BY read_date DESC
    `);
    result.rows.forEach((book) => {
      book.formatted_read_date = new Date(book.read_date).toLocaleString("en-US", {
        timeZone: "Asia/Amman",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hour12: true,
      });
    });
    res.render("shared", { books: result.rows, user: req.user || null });
  } catch (err) {
    console.error(err);
    res.status(500).send("Error retrieving shared books");
  }
});
app.get("/home", async (req, res) => {
  if (!req.isAuthenticated()) {
    return res.redirect("/login");
  }
  const sortBy = req.query.sort || "title";
  let sortQuery = "ORDER BY title ASC";
  if (sortBy === "rating") {
    sortQuery = "ORDER BY rating DESC";
  } else if (sortBy === "date") {
    sortQuery = "ORDER BY read_date DESC";
  }
  try {
    const result = await db.query(
      `SELECT * FROM books WHERE user_id = $1 ${sortQuery}`,
      [req.user.id]
    );
    result.rows.forEach((book) => {
      const localDate = new Date(book.read_date).toLocaleDateString("en-US", {
        timeZone: "Asia/Amman",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hour12: true,
      });
      book.read_date = localDate;
    });
    res.render("home", { books: result.rows, sortBy, user: req.user });
  } catch (err) {
    console.error(err);
    res.status(500).send("Error retrieving books");
  }
});
app.use((req, res, next) => {
  console.log("Session ID:", req.sessionID);
  console.log("Session data:", req.session);
  next();
});

app.get("/books/:id", async (req, res) => {
  if (req.isAuthenticated()) {
    const bookId = req.params.id;
    try {
      const bookResult = await db.query("SELECT * FROM books WHERE id = $1", [bookId]);
      if (bookResult.rows.length === 0) return res.status(404).send("Book not found");
      const book = bookResult.rows[0];
      const ratingsResult = await db.query(`
        SELECT book_ratings.rating, users.username
        FROM book_ratings
        JOIN users ON book_ratings.user_id = users.id
        WHERE book_ratings.book_id = $1
      `, [bookId]);
      res.render("bookDetails", { book, ratings: ratingsResult.rows, user: req.user });
    } catch (err) {
      console.error(err);
      res.status(500).send("Error retrieving book or ratings");
    }
  } else {
    res.redirect("/login");
  }
});

app.get("/add", (req, res) => {
  if (req.isAuthenticated()) {
    res.render("add", {
      title: "",
      author: "",
      read_date: "",
      rating: "",
      cover_id: "",
      cover_id_type: "isbn",
      notes: "",
      user: req.user || null // Add user variable
    });
  } else {
    res.redirect("/login");
  }
});

app.post("/add", async (req, res) => {
  const { title, author, read_date, rating, cover_id, cover_id_type, notes } = req.body;
  const user_id = req.user.id;
  try {
    const coverImageUrl = await fetchBookCover(cover_id_type.toLowerCase(), cover_id);
    const date = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Amman" }));
    const shared = req.body.shared === "on";
    await db.query(
      "INSERT INTO books (title, author, rating, read_date, notes, cover_url, user_id, shared) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)",
      [title, author, rating, date, notes, coverImageUrl, user_id, shared]
    );
    res.redirect("/home");
  } catch (err) {
    console.error(err);
    res.status(500).send("Error adding book");
  }
});

app.get("/edit/:id", async (req, res) => {
  if (req.isAuthenticated()) {
    const id = req.params.id;
    try {
      const result = await db.query("SELECT * FROM books WHERE id=$1", [id]);
      if (result.rows.length === 0) {
        return res.status(404).send("Book not found");
      }
      const book = result.rows[0];
      if (book.user_id !== req.user.id) {
        return res.status(403).send("You don't have permission to edit this book");
      }
      // Format read_date for HTML date input
      book.read_date = book.read_date ? new Date(book.read_date).toISOString().split("T")[0] : "";
      console.log("Book data:", book); // Log to verify data
      console.log("User:", req.user); // Log to verify authentication
      res.render("edit", { book, user: req.user || null });
    } catch (err) {
      console.error("Error loading book for editing:", err);
      res.status(500).send("Error loading book for editing");
    }
  } else {
    res.redirect("/login");
  }
});


app.post("/edit/:id", async (req, res) => {
  const bookId = req.params.id;
  if (req.isAuthenticated()) {
    try {
      const { title, author, read_date, rating, cover_url, notes, shared } = req.body;
      const date = read_date ? new Date(read_date) : new Date();
      if (read_date && isNaN(date)) {
        return res.status(400).send("Invalid date format");
      }
      const result = await db.query("SELECT * FROM books WHERE id=$1", [bookId]);
      if (result.rows.length === 0) {
        return res.status(404).send("Book not found");
      }
      const book = result.rows[0];
      if (book.user_id !== req.user.id) {
        return res.status(403).send("You don't have permission to edit this book");
      }
      await db.query(
        "UPDATE books SET title = $1, author = $2, read_date = $3, rating = $4, cover_url = $5, notes = $6, shared = $7 WHERE id = $8",
        [title, author, date, rating || null, cover_url || null, notes || null, shared === "on", bookId]
      );
      res.redirect("/home");
    } catch (err) {
      console.error("Error updating book:", err);
      res.status(500).send("Error updating book");
    }
  } else {
    res.redirect("/login");
  }
});


app.get("/delete/:id", async (req, res) => {
  if (req.isAuthenticated()) {
    try {
      const result = await db.query("SELECT * FROM books WHERE id=$1", [req.params.id]);
      const book = result.rows[0];
      if (!book) return res.status(404).send("Book not found");
      if (book.user_id !== req.user.id) {
        return res.status(403).send("You don't have permission to delete this book");
      }
      res.render("delete", { book, user: req.user || null });
    } catch (err) {
      console.log(err);
      res.status(500).send("Error fetching post for deletion");
    }
  } else {
    res.redirect("/login");
  }
});

app.post("/delete/:id", async (req, res) => {
  const bookId = req.params.id;
  if (req.isAuthenticated()) {
    try {
      const result = await db.query("SELECT * FROM books WHERE id=$1", [bookId]);
      if (result.rows.length === 0) {
        return res.status(404).send("Book not found");
      }
      const book = result.rows[0];
      if (book.user_id !== req.user.id) {
        return res.status(403).send("You don't have permission to delete this book");
      }
      await db.query("DELETE FROM books WHERE id = $1", [bookId]);
      res.redirect("/home");
    } catch (err) {
      console.error(err);
      res.status(500).send("Error deleting book");
    }
  } else {
    res.redirect("/login");
  }
});

app.get("/signup", async (req, res) => {
  res.render("signup",{ user: req.user || null });
});

app.get("/login", (req, res) => {
  res.render("login", {
    user: null,
    error: null,
  });
});

app.get(
  "/auth/google",
  passport.authenticate("google", {
    scope: ["profile", "email"],
  })
);

app.get(
  "/auth/google/callback",
  passport.authenticate("google", {
    successRedirect: "/",
    failureRedirect: "/signup",
    failureMessage: true,
  }),
  (req, res) => {
    if (req.session.messages) {
      res.render("signup", {
        user: req.user || null,
        error: req.session.messages[0] || "Google sign-up failed.",
      });
    }
  }
);

app.post("/signup", async (req, res) => {
  const { username, email, password } = req.body;

  // Validate email format
  const emailRegex = /^[a-zA-Z0-9._%+-]+@gmail\.com$/i;
  if (!emailRegex.test(email)) {
    return res.render("signup", {
      user: req.user || null,
      error: "Please provide a valid Gmail address (e.g., example@gmail.com).",
    });
  }

  try {
    // Check for existing username
    const checkResult = await db.query("SELECT * FROM users WHERE username = $1", [username]);
    if (checkResult.rows.length > 0) {
      return res.render("signup", {
        user: req.user || null,
        error: "This username already exists. Try logging in.",
      });
    }

    // Check for existing email
    const emailCheck = await db.query("SELECT * FROM users WHERE email = $1", [email]);
    if (emailCheck.rows.length > 0) {
      return res.render("signup", {
        user: req.user || null,
        error: "This email is already registered.",
      });
    }

    // Hash password and create user
    bcrypt.hash(password, saltRounds, async (err, hash) => {
      if (err) {
        console.error("Error hashing password:", err);
        return res.render("signup", {
          user: req.user || null,
          error: "Error processing signup.",
        });
      }
      await db.query(
        "INSERT INTO users (username, email, password_hash) VALUES ($1, $2, $3)",
        [username, email, hash]
      );
      const newUserResult = await db.query("SELECT * FROM users WHERE username = $1", [username]);
      const user = newUserResult.rows[0];
      req.login(user, (err) => {
        if (err) {
          console.error("Login error:", err);
          return res.render("signup", {
            user: req.user || null,
            error: "Login failed.",
          });
        }
        return res.redirect("/home");
      });
    });
  } catch (err) {
    console.error(err);
    res.render("signup", {
      user: req.user || null,
      error: "Internal Server Error",
    });
  }
});

app.get("/shared", async (req, res) => {
  try {
    const result = await db.query(`
      SELECT books.*, users.username,
        COALESCE(AVG(book_ratings.rating), 0) AS average_rating
      FROM books
      LEFT JOIN users ON books.user_id = users.id
      LEFT JOIN book_ratings ON books.id = book_ratings.book_id
      WHERE shared = TRUE
      GROUP BY books.id, users.username
      ORDER BY read_date DESC
    `);
    res.render("shared", { books: result.rows, user: req.user });
  } catch (err) {
    console.error(err);
    res.status(500).send("Error retrieving shared books");
  }
});

app.post("/rate/:bookId", async (req, res) => {
  if (req.isAuthenticated()) {
    const bookId = req.params.bookId;
    const userId = req.user.id;
    const { rating } = req.body;
    try {
      // Check if the book exists and get its user_id
      const bookResult = await db.query("SELECT user_id FROM books WHERE id = $1", [bookId]);
      if (bookResult.rows.length === 0) {
        return res.status(404).send("Book not found");
      }
      const book = bookResult.rows[0];

      // Check for existing rating
      const existingRating = await db.query(
        "SELECT * FROM book_ratings WHERE book_id = $1 AND user_id = $2",
        [bookId, userId]
      );

      if (existingRating.rows.length > 0) {
        // Update existing rating
        await db.query(
          "UPDATE book_ratings SET rating = $1 WHERE book_id = $2 AND user_id = $3",
          [rating, bookId, userId]
        );
      } else {
        // Insert new rating
        await db.query(
          "INSERT INTO book_ratings (book_id, user_id, rating) VALUES ($1, $2, $3)",
          [bookId, userId, rating]
        );
      }
      res.redirect("/shared");
    } catch (err) {
      console.error("Error submitting rating:", err);
      res.status(500).send("Error submitting rating");
    }
  } else {
    res.redirect("/login");
  }
});

app.get("/logout", (req, res) => {
  req.logout((err) => {
    if (err) {
      console.error(err);
      return res.status(500).send("Logout failed");
    }
    res.redirect("/");
  });
});

app.post("/login", (req, res, next) => {
  passport.authenticate("local", (err, user, info) => {
    if (err) return next(err);

    if (!user) {
      // Authentication failed
      return res.render("login", {
        user: null,
        error: "Invalid username or password.", // Or use info.message if set
      });
    }

    // Manually log the user in
    req.logIn(user, (err) => {
      if (err) return next(err);
      return res.redirect("/home");
    });
  })(req, res, next);
});

async function fetchBookCover(cover_id_type, cover_id, retries = 3) {
  const size = 'M';
  let url;
  if (cover_id_type === 'isbn') {
    url = `https://openlibrary.org/isbn/${cover_id}.json`;
  } else if (cover_id_type === 'id') {
    url = `https://openlibrary.org/id/${cover_id}.json`;
  } else if (cover_id_type === 'olid') {
    url = `https://openlibrary.org/works/OL${cover_id}W.json`;
  } else {
    console.error("Invalid cover_id_type:", cover_id_type);
    return "https://via.placeholder.com/150";
  }
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const response = await axios.get(url);
      const coverId = response.data.covers && response.data.covers[0];
      if (coverId) {
        return `https://covers.openlibrary.org/b/id/${coverId}-${size}.jpg`;
      } else {
        console.warn(`No cover found for book with ${cover_id_type}:${cover_id}`);
        return "https://via.placeholder.com/150";
      }
    } catch (error) {
      console.error(
        `Attempt ${attempt} - Error fetching book cover for ${cover_id_type}:${cover_id}:`,
        error.message
      );
      if (attempt < retries && error.response && [500, 502, 503].includes(error.response.status)) {
        await new Promise((resolve) => setTimeout(resolve, 1000));
      } else {
        break;
      }
    }
  }
  return "https://via.placeholder.com/150";
}

passport.use(
  "local",
  new Strategy(async function verify(username, password, cb) {
    try {
      const result = await db.query("SELECT * FROM users WHERE username = $1", [username]);
      if (result.rows.length > 0) {
        const user = result.rows[0];
        const storedHashedPassword = user.password_hash;
        bcrypt.compare(password, storedHashedPassword, (err, valid) => {
          if (err) {
            console.error("Error comparing passwords:", err);
            return cb(err);
          }
          if (valid) {
            return cb(null, user);
          } else {
            return cb(null, false);
          }
        });
      } else {
        return cb(null, false, { message: "User not found" });
      }
    } catch (err) {
      console.error(err);
      return cb(err);
    }
  })
);

passport.use(
  new GoogleStrategy(
    {
      clientID: process.env.GOOGLE_CLIENT_ID,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET,
      callbackURL: process.env.CALL_BACK_URL ||"https://chapter-bloom-book-note.vercel.app//auth/google/callback",
      passReqToCallback: true,
    },
    async (request, accessToken, refreshToken, profile, done) => {
      try {
        const email = profile.email;
        if (!email.match(/^[a-zA-Z0-9._%+-]+@gmail\.com$/i)) {
          return done(null, false, { message: "Only Gmail addresses are allowed." });
        }
        const result = await db.query("SELECT * FROM users WHERE email = $1", [email]);
        if (result.rows.length > 0) {
          return done(null, result.rows[0]);
        } else {
          const newUser = await db.query(
            "INSERT INTO users (username, email, password_hash) VALUES ($1, $2, $3) RETURNING *",
            [profile.displayName, email, profile.id]
          );
          return done(null, newUser.rows[0]);
        }
      } catch (err) {
        return done(err);
      }
    }
  )
);

passport.serializeUser((user, done) => {
  done(null, user.id);
});

passport.deserializeUser(async (id, done) => {
  try {
    const result = await db.query("SELECT * FROM users WHERE id = $1", [id]);
    if (result.rows.length > 0) {
      done(null, result.rows[0]);
    } else {
      done(null, false);
    }
  } catch (err) {
    done(err, null);
  }
});

app.listen(port, () => {
  console.log(`Server is running on port ${port}.`);
});