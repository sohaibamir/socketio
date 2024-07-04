import fs from 'fs';
import path from 'path';

class LoggingService {
  private static logFilePath: string = path.resolve(__dirname, 'connectionLogs.txt');

  /**
   * Logs connection details.
   * @param namespace - The namespace name
   * @param socketId - The socket ID
   */
  public static logConnection(namespace: string, socketId: string): void {
    const logEntry = `Namespace: ${namespace}, Socket ID: ${socketId}, Timestamp: ${new Date().toISOString()}\n`;
    this.writeLog(logEntry);
     // You can extend this to actually log to a file or database 
     
  }

  /**
   * Writes a log entry to the log file.
   * @param logEntry - The log entry to write
   */
  private static writeLog(logEntry: string): void {
    fs.appendFile(this.logFilePath, logEntry, (err) => {
      if (err) {
        console.error('Failed to write log:', err);
      } else {
        console.log('Log entry added.');
      }
    });
  }
}

export default LoggingService;
