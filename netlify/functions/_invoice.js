const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');

const COMPANY_NAME = process.env.COMPANY_NAME || '[SET COMPANY_NAME ENV VAR]';
const COMPANY_REG_NO = process.env.COMPANY_REG_NO || '[SET COMPANY_REG_NO ENV VAR]';
const COMPANY_ADDRESS = process.env.COMPANY_ADDRESS || '[SET COMPANY_ADDRESS ENV VAR]';
const COMPANY_SST_NO = process.env.COMPANY_SST_NO || ''; // leave blank if not SST-registered

function fmtRM(cents) {
  return 'RM ' + (cents / 100).toLocaleString('en-MY', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

async function generateInvoicePdf({ bookingId, cohort, delegates, pricing, contactEmail, paidAt }) {
  const doc = await PDFDocument.create();
  const page = doc.addPage([595.28, 841.89]); // A4
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);

  let y = 800;
  const left = 50;
  const ink = rgb(0.07, 0.09, 0.12);
  const grey = rgb(0.4, 0.4, 0.38);

  const draw = (text, opts = {}) => {
    page.drawText(text, {
      x: opts.x ?? left,
      y,
      size: opts.size ?? 10,
      font: opts.bold ? bold : font,
      color: opts.color ?? ink
    });
    y -= opts.gap ?? 16;
  };

  draw(COMPANY_NAME, { size: 16, bold: true, gap: 20 });
  draw(COMPANY_ADDRESS, { size: 9, color: grey, gap: 12 });
  draw(`Company Registration No: ${COMPANY_REG_NO}`, { size: 9, color: grey, gap: 12 });
  if (COMPANY_SST_NO) draw(`SST Registration No: ${COMPANY_SST_NO}`, { size: 9, color: grey, gap: 12 });
  y -= 10;

  draw('OFFICIAL RECEIPT / TAX INVOICE', { size: 13, bold: true, gap: 20 });
  draw(`Invoice No: ${bookingId}`, { size: 10, gap: 14 });
  draw(`Date: ${new Date(paidAt).toLocaleDateString('en-MY', { day: '2-digit', month: 'long', year: 'numeric' })}`, { size: 10, gap: 14 });
  draw(`Billed to: ${contactEmail}`, { size: 10, gap: 20 });

  draw(`Programme: ${cohort.programmeName}`, { size: 11, bold: true, gap: 16 });
  draw(`Cohort: ${cohort.label}${cohort.trackLabel ? ' · ' + cohort.trackLabel : ''}`, { size: 10, gap: 16 });
  draw(`Venue: ${cohort.venue}`, { size: 10, gap: 20 });

  draw('Delegates', { size: 11, bold: true, gap: 16 });
  draw('Name', { x: left, size: 9, color: grey });
  draw('Position', { x: left + 190, size: 9, color: grey, gap: 0 });
  draw('Company', { x: left + 360, size: 9, color: grey, gap: 16 });

  delegates.forEach((d) => {
    const rowY = y;
    page.drawText(d.name, { x: left, y: rowY, size: 10, font, color: ink });
    page.drawText(d.position, { x: left + 190, y: rowY, size: 10, font, color: ink });
    page.drawText(d.company, { x: left + 360, y: rowY, size: 10, font, color: ink });
    y -= 16;
  });

  y -= 14;
  draw(`Rate per delegate: ${fmtRM(pricing.perSeat)}`, { size: 10, gap: 14 });
  draw(`Number of delegates: ${pricing.seatCount}`, { size: 10, gap: 14 });
  draw(`Training subtotal: ${fmtRM(pricing.total)}`, { size: 10, gap: 14 });
  if (pricing.bookingProtectionSelected && pricing.bookingProtectionFee > 0) {
    draw(`Booking Protection (non-refundable): ${fmtRM(pricing.bookingProtectionFee)}`, { size: 10, gap: 14 });
  }
  draw(`Total paid: ${fmtRM(pricing.grandTotal ?? pricing.total)}`, { size: 13, bold: true, gap: 24 });

  draw('This programme is HRD Corp claimable. Retain this receipt for your claim submission.', {
    size: 9, color: grey, gap: 12
  });

  const bytes = await doc.save();
  return Buffer.from(bytes);
}

module.exports = { generateInvoicePdf };
