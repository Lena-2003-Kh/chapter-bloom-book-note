// Import required modules
import express from "express";                // Express framework for handling routes and middleware
import bodyParser from "body-parser";        // Middleware to parse incoming request bodies
import pg from "pg";                         // PostgreSQL client for Node.js
import axios from "axios";                   // Axios for making HTTP requests
import bcrypt from "bcrypt";                 // Password hashing
import passport from "passport";             // Authentication middleware
import { Strategy } from "passport-local";   // Local authentication strategy
import session from "express-session";       // Session middleware
import env from "dotenv";                    // Environment variable management
import pgSession from "connect-pg-simple";   // PostgreSQL session store
import GoogleStrategy from "passport-google-oauth2";
// Initialize pgSession with express-session
const PgSessionStore = pgSession(session); // Correctly initialize the session store
// Create an Express application
const app = express();

// Set the port the server will listen on
const port = 3000;
const saltRounds=12; 
env.config();

// Configure and connect to the PostgreSQL database
const db = new pg.Client({
  user: process.env.PG_USER,                         // Database username
  host: process.env.PG_HOST,                        // Database host
  database: process.env.PG_DATABASE,                        // Name of the database
  password: process.env.PG_PASSWORD,                // Database password
  port: process.env.PG_PORT,                               // PostgreSQL default port
});
db.connect();                               // Establish connection to the database


// Configure session middleware with PostgreSQL store
app.use(
  session({
    store: new PgSessionStore({
      pool: db,                           // Use the PostgreSQL client pool
      tableName:process.env.PG_TABLE_SESSIONS,               // Table name for storing sessions
    }),
    secret: process.env.SESSION_SECRET,    // Session secret
    resave: false,                        // Don't resave session if unmodified
    saveUninitialized: false,              // Don't save uninitialized sessions
    cookie: { maxAge: 1000 * 60 * 60 * 24 }, // 1 day
  })
);
// Middleware to parse URL-encoded data from forms
app.use(bodyParser.urlencoded({ extended: true }));

// Serve static files (like CSS, JS, images) from the "public" directory
app.use(express.static("public"));

// Set the view engine to EJS for rendering dynamic HTML
app.set("view engine", "ejs");

app.use(passport.initialize());
app.use(passport.session());

// Route for the homepage with sorting functionality
app.get("/", async (req, res) => {
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
    // 👇 Filter books by the logged-in user's ID
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

    res.render("index", { books: result.rows, sortBy });
  } catch (err) {
    console.error(err);
    res.status(500).send("Error retrieving books");
  }
});


// Route to view details of a specific book by ID
app.get("/books/:id", async (req, res) => {
  if (req.isAuthenticated()) {
    const bookId = req.params.id;
    const userId = req.user.id;

    try {
      // Get the book details
      const bookResult = await db.query("SELECT * FROM books WHERE id = $1 AND user_id = $2", [bookId, userId]);
      if (bookResult.rows.length === 0) return res.status(404).send("Book not found");
      const book = bookResult.rows[0];

      // Get the ratings for the book
      const ratingsResult = await db.query(`
        SELECT book_ratings.rating, users.username
        FROM book_ratings
        JOIN users ON book_ratings.user_id = users.id
        WHERE book_ratings.book_id = $1
      `, [bookId]);

      res.render("bookDetails", { book, ratings: ratingsResult.rows });
    } catch (err) {
      console.error(err);
      res.status(500).send("Error retrieving book or ratings");
    }
  } else {
    res.redirect("login");
  }
});


// Route to show the form for adding a new book
app.get("/add", (req, res) => {
  if(req.isAuthenticated()){
  res.render("add", {
    title: "",               // Empty fields for the add form
    author: "",
    read_date: "",
    rating: "",
    cover_id: "",
    cover_id_type: "isbn",
    notes: ""
  });}else{
    res.redirect("login");
  }
});

// Route to handle form submission for adding a book
app.post("/add", async (req, res) => {
  const { title, author, read_date, rating, cover_id, cover_id_type, notes } = req.body;
  const user_id = req.user.id; // Inject logged-in user's ID

  try {
    const coverImageUrl = await fetchBookCover(cover_id_type.toLowerCase(), cover_id);
    const date = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Amman" }));

    const shared = req.body.shared === "on"; // Checkbox returns "on" if checked

await db.query(
  "INSERT INTO books (title, author, rating, read_date, notes, cover_url, user_id, shared) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)",
  [title, author, rating, date, notes, coverImageUrl, user_id, shared]
);


    res.redirect("/");
  } catch (err) {
    console.error(err);
    res.status(500).send("Error adding book");
  }
});


// Route to show the form for editing an existing book
app.get("/edit/:id", async (req, res) => {
  if(req.isAuthenticated()){
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
      res.render("edit", { book });
    } catch (err) {
      console.error(err);
      res.status(500).send("Error loading book for editing");
    }
  } else {
    res.redirect("login");
  }
});

// Route to handle the update of an edited book
app.post("/edit/:id", async (req, res) => {
  const bookId = req.params.id;
  if (req.isAuthenticated()) {
    try {
      const { title, author, read_date, rating, cover_url, notes } = req.body;
      const date = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Amman" }));

      const result = await db.query("SELECT * FROM books WHERE id=$1", [bookId]);
      if (result.rows.length === 0) {
        return res.status(404).send("Book not found");
      }
      const book = result.rows[0];

      await db.query(
        "UPDATE books SET title = $1, author = $2, read_date = $3, rating = $4, cover_url = $5, notes = $6 WHERE id = $7",
        [title, author, date, rating, cover_url, notes, bookId]
      );

      res.redirect("/");  // Redirect after updating
    } catch (err) {
      console.error(err);
      res.status(500).send("Error updating book");
    }
  } else {
    res.redirect("login");
  }
});

// Route to show confirmation page before deleting a book
app.get("/delete/:id", async (req, res) => {
  if(req.isAuthenticated()){
try {
    const result = await db.query("SELECT * FROM books WHERE id=$1", [req.params.id]);
    const book = result.rows[0];
    if (!book) return res.status(404).send("Book not found");

    if (book.user_id !== req.user.id) {
      return res.status(403).send("You don't have permission to delete this book");
    }

    res.render("delete", { book });   // Show confirmation form
  } catch (err) {
    console.log(err);
    res.status(500).send("Error fetching post for deletion");
  }}else{
    res.redirect("login");
  }
});

// Route to handle the deletion of a book
app.post("/delete/:id", async (req, res) => {
  const bookId = req.params.id;
  if (req.isAuthenticated()) {
    try {
      const result = await db.query("SELECT * FROM books WHERE id=$1", [bookId]);
      if (result.rows.length === 0) {
        return res.status(404).send("Book not found");
      }
      const book = result.rows[0];

      // Ensure the book belongs to the logged-in user
      if (book.user_id !== req.user.id) {
        return res.status(403).send("You don't have permission to delete this book");
      }

      await db.query("DELETE FROM books WHERE id = $1", [bookId]);
      res.redirect("/");
    } catch (err) {
      console.error(err);
      res.status(500).send("Error deleting book");
    }
  } else {
    res.redirect("login");
  }
});

app.get("/signup",async(req,res)=>{
  
  res.render("signup");
});

app.get("/login",async(req,res)=>{
  
  res.render("login");
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
    failureRedirect: "/login",
  })
);
// Signup route
app.post("/signup", async (req, res) => {
  const { username, email, password } = req.body;

  try {
    const checkResult = await db.query("SELECT * FROM users WHERE username = $1", [username]);

    if (checkResult.rows.length > 0) {
      res.send("This username already exists. Try logging in.");
    } else {
      bcrypt.hash(password, saltRounds, async (err, hash) => {
        if (err) {
          console.error("Error hashing password:", err);
          return res.status(500).send("Error processing signup.");
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
            return res.status(500).send("Login failed.");
          }
          return res.redirect("/");
        });
      });
    }
  } catch (err) {
    console.error(err);
    res.status(500).send("Internal Server Error");
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

    res.render("shared", { books: result.rows });
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
      // Insert the rating into the book_ratings table
      await db.query(
        "INSERT INTO book_ratings (book_id, user_id, rating) VALUES ($1, $2, $3)",
        [bookId, userId, rating]
      );

      // Redirect back to the book details page
      res.redirect(`/books/${bookId}`);
    } catch (err) {
      console.error(err);
      res.status(500).send("Error submitting rating");
    }
  } else {
    res.redirect("/login");
  }
});

// Logout route
app.get("/logout", (req, res) => {
  req.logout((err) => {
    if (err) {
      console.error(err);
      return res.status(500).send("Logout failed");
    }
    res.redirect("/");
  });
});

app.post(
  "/login",
  passport.authenticate("local", {//this is the method which will trigger the strategy method down 
    successRedirect: "/",
    failureRedirect: "/login",
  })
);

// Function to fetch book cover image using OpenLibrary API
async function fetchBookCover(cover_id_type, cover_id, retries = 3) {
  const size = 'M';    // Desired cover size
  let url;

  // Build the URL based on cover_id_type
  if (cover_id_type === 'isbn') {
    url = `https://openlibrary.org/isbn/${cover_id}.json`;
  } else if (cover_id_type === 'id') {
    url = `https://openlibrary.org/id/${cover_id}.json`;
  } else if (cover_id_type === 'olid') {
    url = `https://openlibrary.org/works/OL${cover_id}W.json`;
  } else {
    console.error("Invalid cover_id_type:", cover_id_type);
    return "https://via.placeholder.com/150"; // Return placeholder if invalid type
  }

  //for Try to fetch the cover data, retrying on server errors
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const response = await axios.get(url);   // Make the request
      const coverId = response.data.covers && response.data.covers[0];   // Extract cover ID

      if (coverId) {
        return `https://covers.openlibrary.org/b/id/${coverId}-${size}.jpg`;
      } else {
        console.warn(`No cover found for book with ${cover_id_type}:${cover_id}`);
        return "https://via.placeholder.com/150"; // Return default if no cover found
      }
    } catch (error) {
      console.error(
        `Attempt ${attempt} - Error fetching book cover for ${cover_id_type}:${cover_id}:`,
        error.message
      );

      // Retry only for server-related errors
      if (attempt < retries && error.response && [500, 502, 503].includes(error.response.status)) {
        await new Promise((resolve) => setTimeout(resolve, 1000)); // Wait before retry
      } else {
        break; // Stop retrying for other errors
      }
    }
  }

  // Return a default cover if all attempts fail
  return "https://via.placeholder.com/150";
}

passport.use("local",
  new Strategy(async function verify(username, password, cb) {
    try {
      const result = await db.query("SELECT * FROM users WHERE username = $1", [username]);
      if (result.rows.length > 0) {
        const user = result.rows[0];
        const storedHashedPassword = user.password_hash; // Match column name
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
      return cb(err); // Ensure callback is called
    }
  })
);
passport.use(
  new GoogleStrategy(
    {
      clientID: process.env.GOOGLE_CLIENT_ID,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET,
      callbackURL: "http://localhost:3000/auth/google/callback",
      passReqToCallback: true,
    },
    async (request, accessToken, refreshToken, profile, done) => {
      try {
        // Check if user exists in DB
        const result = await db.query("SELECT * FROM users WHERE email = $1", [profile.email]);
        if (result.rows.length > 0) {
          return done(null, result.rows[0]); // Login existing user
        } else {
          // Insert new user
          const newUser = await db.query(
            "INSERT INTO users (username, email, password_hash) VALUES ($1, $2, $3) RETURNING *",
            [profile.displayName, profile.email, profile.id]
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
  done(null, user.id); // store only user ID in the session
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

// Start the server on the specified port
app.listen(port, () => {
  console.log(`Server is running on port ${port}.`);
});
