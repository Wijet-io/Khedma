import { supabase } from '../../lib/supabase';
import { getAttendanceForPeriod } from '../jibble/api';
import { Employee } from '../../types/employee';
import { AttendanceRecord } from '../../types/attendance';
import { parseHours } from '../../utils/hours';

interface ImportProgress {
  total: number;
  current: number;
  status: 'pending' | 'processing' | 'completed' | 'error';
  message?: string;
}

export class AttendanceImporter {
  private progress: ImportProgress = {
    total: 0,
    current: 0,
    status: 'pending'
  };

  private onProgressUpdate?: (progress: ImportProgress) => void;

  constructor(callback?: (progress: ImportProgress) => void) {
    this.onProgressUpdate = callback;
  }

  private updateProgress(update: Partial<ImportProgress>) {
    this.progress = { ...this.progress, ...update };
    this.onProgressUpdate?.(this.progress);
  }

  async importForEmployee(
    employee: Employee,
    startDate: string,
    endDate: string
  ): Promise<AttendanceRecord[]> {
    try {
      const timesheets = await getAttendanceForPeriod(
        employee.id,
        startDate,
        endDate
      );

      if (!timesheets || !Array.isArray(timesheets)) {
        console.log(`No timesheets found for employee ${employee.id}`);
        return [];
      }

      const records = await Promise.all(
        timesheets
        .filter(timesheet => timesheet.daily && Array.isArray(timesheet.daily) && timesheet.daily.length > 0)
        .map(async (timesheet) => {
          const daily = timesheet.daily[0];
          if (!daily || !daily.payrollHours) {
            console.log(`Invalid timesheet data for employee ${employee.id}`);
            return null;
          }
          
          const totalHours = parseHours(daily.payrollHours);

          // Déterminer le statut
          let status: AttendanceRecord['status'] = 'VALID';
          if (totalHours > 13) {
            status = 'NEEDS_CORRECTION';
          } else if (totalHours < employee.minHours) {
            status = 'TO_VERIFY';
          }

          const record: Partial<AttendanceRecord> = {
            employeeId: employee.id,
            employeeName: `${employee.firstName} ${employee.lastName}`,
            date: daily.date,
            normalHours: Math.min(totalHours, employee.minHours),
            extraHours: Math.max(0, totalHours - employee.minHours),
            status,
            originalData: {
              startTime: daily.firstIn,
              endTime: daily.lastOut,
              totalHours,
              source: 'JIBBLE'
            },
            lastImportId: crypto.randomUUID()
          };

          // Ne pas écraser les enregistrements corrigés
          const { data: existing } = await supabase
            .from('attendance_records')
            .select('status')
            .eq('employee_id', employee.id)
            .eq('date', daily.date)
            .single();

          if (!existing || existing.status !== 'CORRECTED') {
            const { data, error } = await supabase
              .from('attendance_records')
              .upsert(record)
              .select()
              .single();

            if (error) throw error;
            return data as AttendanceRecord;
          }
          return null;
        })
      ).then(records => records.filter((r): r is AttendanceRecord => r !== null));
      
      return records;
    } catch (error) {
      console.error(`Import failed for employee ${employee.id}:`, error);
      throw error;
    }
  }

  async importForPeriod(
    startDate: string,
    endDate: string,
    employeeIds?: string[]
  ): Promise<AttendanceRecord[]> {
    try {
      this.updateProgress({ status: 'processing', current: 0 });

      const { data: employees, error } = await supabase
        .from('employees')
        .select('*')
        .in('id', employeeIds || [])
        .order('last_name');

      if (error) throw error;
      if (!employees?.length) {
        throw new Error('No employees found');
      }

      this.updateProgress({ total: employees.length });

      const results: AttendanceRecord[] = [];
      for (const employee of employees) {
        try {
          const records = await this.importForEmployee(employee, startDate, endDate);
          if (records) {
            results.push(...records);
          }
          
          this.updateProgress({
            current: this.progress.current + 1,
            message: `Importé pour ${employee.first_name} ${employee.last_name}`
          });
        } catch (error) {
          console.error(`Failed to import for ${employee.id}:`, error);
          // Continue with next employee
        }
      }

      this.updateProgress({ 
        status: 'completed',
        message: `Import terminé pour ${results.length} pointages`
      });

      return results;
    } catch (error) {
      this.updateProgress({
        status: 'error',
        message: error instanceof Error ? error.message : 'Unknown error'
      });
      throw error;
    }
  }
}