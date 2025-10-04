# PrintPro Printer Backend

Backend service for communicating with HP N451NW printer via Dell Wyse terminal.

## Features

- Direct communication with HP LaserJet Pro 400 M451nw
- Dell Wyse thin client integration
- Image processing and optimization for printing
- Print job management and status tracking
- Security middleware and rate limiting
- File upload handling with validation

## Setup

### Prerequisites

1. **Dell Wyse Terminal** configured and connected to network
2. **HP N451NW Printer** connected to network
3. **Node.js** (v16 or higher)
4. **Network access** to both Wyse terminal and printer

### Installation

```bash
cd printer-backend
npm install
```

### Configuration

1. Copy `.env.example` to `.env`
2. Update the configuration values:

```env
# Printer Configuration
PRINTER_NAME=HP LaserJet Pro 400 M451nw
PRINTER_IP=192.168.1.100
PRINTER_PORT=9100

# Dell Wyse Configuration
WYSE_HOST=192.168.1.50
WYSE_USERNAME=admin

# Server Configuration
PORT=3001
FRONTEND_URL=http://localhost:5173
```

### Network Setup

1. **Find your HP N451NW IP address:**
   - Print a network configuration page from the printer
   - Or check your router's connected devices

2. **Configure Dell Wyse:**
   - Ensure Wyse terminal can access the printer
   - Configure print drivers for HP N451NW
   - Test printing from Wyse terminal

3. **Network connectivity:**
   - Ensure backend server can reach both Wyse and printer
   - Configure firewall rules if necessary

## Usage

### Start the server

```bash
# Development
npm run dev

# Production
npm start
```

### API Endpoints

#### Health Check
```
GET /health
```

#### Get Available Printers
```
GET /api/printers
```

#### Submit Print Job
```
POST /api/print
Content-Type: multipart/form-data

Body:
- image: File (required)
- printSize: string (4x6, a5, a4)
- quantity: number
- copies: number
```

#### Check Print Status
```
GET /api/print-status/:jobId
```

## Dell Wyse Integration

This backend is designed to work with Dell Wyse thin clients that have:

1. **Network connectivity** to HP N451NW printer
2. **Print drivers** installed for HP LaserJet Pro 400 series
3. **Network printing** configured
4. **API access** enabled (if supported by your Wyse model)

### Supported Wyse Models

- Dell Wyse 5070
- Dell Wyse 3040
- Dell Wyse 7020
- Other network-capable Wyse terminals

## Printer Specifications

**HP LaserJet Pro 400 M451nw:**
- Color laser printer
- Network connectivity (Ethernet/WiFi)
- PCL 6, PostScript 3 support
- Maximum resolution: 600 x 600 dpi
- Supported media sizes: A4, A5, 4x6, Letter, Legal

## Security Features

- **Rate limiting**: 100 requests per 15 minutes per IP
- **File validation**: Only images and PDFs allowed
- **File size limits**: 10MB maximum
- **Helmet.js**: Security headers
- **CORS protection**: Configurable origins
- **Input sanitization**: All user inputs validated

## Troubleshooting

### Common Issues

1. **Printer not found:**
   - Check network connectivity
   - Verify printer IP address
   - Ensure printer drivers are installed

2. **Wyse connection failed:**
   - Verify Wyse terminal IP address
   - Check network connectivity
   - Ensure proper authentication

3. **Print job fails:**
   - Check printer status and paper
   - Verify image format and size
   - Check printer queue

### Logs

Server logs include:
- Print job submissions
- Printer communication status
- Error messages and stack traces
- File processing information

## Production Deployment

1. **Environment variables**: Set all required env vars
2. **Process manager**: Use PM2 or similar
3. **Reverse proxy**: Configure nginx/Apache
4. **SSL/TLS**: Enable HTTPS
5. **Monitoring**: Set up health checks
6. **Backup**: Regular configuration backups

## API Integration

To integrate with the main PrintPro frontend:

```javascript
// Example API call
const printResponse = await fetch('http://localhost:3001/api/print', {
  method: 'POST',
  body: formData // FormData with image file
});

const result = await printResponse.json();
```

## License

MIT License - see LICENSE file for details.