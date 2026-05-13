// =============================================================================
//  MadLib Peer Evaluation - Google Apps Script Backend
//  Project C / Muslim Creator Journalism Accelerator
// =============================================================================
//
//  SETUP (about 5 minutes):
//
//  1. Go to https://script.google.com and click "New project"
//  2. Delete the default code and paste this entire file in
//  3. Edit DRIVE_FOLDER_NAME below if you want a different root folder name
//  4. Click the floppy-disk icon to save
//  5. Click "Deploy" -> "New deployment"
//       - Type: Web app
//       - Execute as: Me
//       - Who has access: Anyone
//  6. Click "Deploy" and copy the Web App URL
//  7. Paste that URL into the scriptUrl field in madlib-eval.html
//  8. Done! Each submission creates a Google Doc in your Drive.
//
//  WHAT GETS CREATED IN DRIVE:
//
//  MadLib Evaluations/  (root folder, created automatically)
//    Rabia Chaudry/
//      Rabia Chaudry - Evaluated by Husam - May 6 2026
//      Rabia Chaudry - Evaluated by Ameer - May 6 2026
//    Husam Kaid/
//      ...
//
// =============================================================================

// Root folder name in Google Drive
var DRIVE_FOLDER_NAME = "MadLib Evaluations";

// Rating value to label mapping
var RATING_LABELS = {
  "Strong":     "[Strong]",
  "Developing": "[Developing]",
  "Unclear":    "[Unclear]",
  "":           "[Not rated]"
};

// Criteria: maps form field names to readable labels and sections
var CRITERIA = [
  // Section 1 - Identity & Niche
  { field: "r_niche_specific", label: "Niche is specific and distinct",             section: "Identity & Niche" },
  { field: "r_audience",       label: "Target audience is clearly defined",         section: "Identity & Niche" },
  { field: "r_whyme",          label: "Why me is compelling and personal",          section: "Identity & Niche" },
  // Section 2 - Audience & Funnel
  { field: "r_platform",       label: "Existing platform is a credible foundation", section: "Audience & Funnel Strategy" },
  { field: "r_funnel",         label: "Attract/Engage/Convert funnel is coherent",  section: "Audience & Funnel Strategy" },
  // Section 3 - Editorial Plan
  { field: "r_cadence",        label: "Publishing cadence feels sustainable",       section: "Editorial Plan" },
  { field: "r_pillars",        label: "Content pillars are distinct and coherent",  section: "Editorial Plan" },
  { field: "r_metric",         label: "Evaluation metric makes sense",              section: "Editorial Plan" },
  // Section 4 - Business Viability
  { field: "r_financials",     label: "Financial targets feel realistic",           section: "Business Viability" },
  { field: "r_revenue",        label: "Revenue model is clearly defined",           section: "Business Viability" },
  { field: "r_buyers",         label: "First 10 buyers are specific and reachable", section: "Business Viability" },
  { field: "r_timeline",       label: "Launch timeline is achievable",              section: "Business Viability" }
];

// =============================================================================
//  Entry points
// =============================================================================

function doPost(e) {
  try {
    var raw  = e.postData ? e.postData.contents : "{}";
    var data = JSON.parse(raw);
    createEvalDoc(data);
    return ContentService
      .createTextOutput(JSON.stringify({ status: "ok" }))
      .setMimeType(ContentService.MimeType.JSON);
  } catch (err) {
    return ContentService
      .createTextOutput(JSON.stringify({ status: "error", message: err.toString() }))
      .setMimeType(ContentService.MimeType.JSON);
  }
}

// Visit the web app URL in a browser to confirm it is running
function doGet() {
  return ContentService
    .createTextOutput("MadLib Eval backend is running.")
    .setMimeType(ContentService.MimeType.TEXT);
}

// =============================================================================
//  Core: create a Google Doc for each submission
// =============================================================================

function createEvalDoc(data) {
  var presenter   = (data.presenter   || "Unknown").trim();
  var evaluator   = (data.evaluator   || "Anonymous").trim();
  var submittedAt = data.submitted_at
    ? new Date(data.submitted_at).toLocaleString("en-US", { timeZone: "America/New_York" })
    : new Date().toLocaleString("en-US", { timeZone: "America/New_York" });

  // Get or create folders
  var rootFolder      = getOrCreateFolder(DriveApp.getRootFolder(), DRIVE_FOLDER_NAME);
  var presenterFolder = getOrCreateFolder(rootFolder, presenter);

  // Create the Doc
  var docTitle = presenter + " - Evaluated by " + evaluator + " - " + formatDateShort();
  var doc  = DocumentApp.create(docTitle);
  var body = doc.getBody();

  // Header
  var titlePara = body.appendParagraph("MadLib Peer Evaluation");
  titlePara.setHeading(DocumentApp.ParagraphHeading.HEADING1);

  appendKeyValue(body, "Presenter",    presenter);
  appendKeyValue(body, "Evaluated by", evaluator);
  appendKeyValue(body, "Submitted",    submittedAt);
  body.appendHorizontalRule();

  // Ratings grouped by section
  var sections = [
    "Identity & Niche",
    "Audience & Funnel Strategy",
    "Editorial Plan",
    "Business Viability"
  ];

  for (var s = 0; s < sections.length; s++) {
    var sectionName     = sections[s];
    var sectionCriteria = CRITERIA.filter(function(c) { return c.section === sectionName; });
    if (!sectionCriteria.length) continue;

    var secPara = body.appendParagraph(sectionName);
    secPara.setHeading(DocumentApp.ParagraphHeading.HEADING2);

    for (var i = 0; i < sectionCriteria.length; i++) {
      var c      = sectionCriteria[i];
      var rating = RATING_LABELS[data[c.field] || ""] || "[Not rated]";
      var p      = body.appendParagraph(rating + "  " + c.label);
      p.setFontSize(11);
      p.setSpacingBefore(2);
      p.setSpacingAfter(2);
    }
  }

  body.appendHorizontalRule();

  // Written feedback
  var fbPara = body.appendParagraph("Written Feedback");
  fbPara.setHeading(DocumentApp.ParagraphHeading.HEADING2);

  var feedbackFields = [
    { field: "f_compelling", label: "Most compelling thing about this plan" },
    { field: "f_question",   label: "One question to think more about" },
    { field: "f_suggestion", label: "One concrete suggestion" },
    { field: "f_other",      label: "Other notes" }
  ];

  for (var f = 0; f < feedbackFields.length; f++) {
    var ff  = feedbackFields[f];
    var val = (data[ff.field] || "").trim();
    if (!val) continue;

    var labelP = body.appendParagraph(ff.label);
    labelP.setFontSize(11);
    labelP.setBold(true);
    labelP.setSpacingBefore(10);

    var valP = body.appendParagraph(val);
    valP.setFontSize(11);
    valP.setBold(false);
    valP.setSpacingAfter(6);
  }

  doc.saveAndClose();

  // Move Doc out of Drive root and into the presenter's folder
  var file = DriveApp.getFileById(doc.getId());
  presenterFolder.addFile(file);
  DriveApp.getRootFolder().removeFile(file);
}

// =============================================================================
//  Helpers
// =============================================================================

function getOrCreateFolder(parent, name) {
  var existing = parent.getFoldersByName(name);
  if (existing.hasNext()) return existing.next();
  return parent.createFolder(name);
}

function appendKeyValue(body, key, value) {
  var p = body.appendParagraph(key + ": " + value);
  p.setFontSize(11);
  p.setSpacingBefore(2);
  p.setSpacingAfter(2);
}

function formatDateShort() {
  return Utilities.formatDate(new Date(), "America/New_York", "MMM d yyyy");
}
