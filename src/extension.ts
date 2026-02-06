import * as vscode from 'vscode';
import * as path from 'path';
import axios from 'axios';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

// Monday.com API token - must be set via MONDAY_TOKEN env var or settings
function getMondayToken(): string {
  return process.env.MONDAY_TOKEN || vscode.workspace.getConfiguration('togglTrackAuto').get<string>('mondayToken') || '';
}

async function runSetupWizard(): Promise<boolean> {
  const config = vscode.workspace.getConfiguration('togglTrackAuto');
  
  // Check if already configured
  if (config.get<string>('apiToken') && config.get<number>('workspaceId')) {
    return true;
  }

  const start = await vscode.window.showInformationMessage(
    '🚀 Welcome to Toggl Track Auto! Let\'s set it up.',
    'Start Setup',
    'Later'
  );

  if (start !== 'Start Setup') {
    return false;
  }

  // Step 1: API Token
  const tokenInfo = await vscode.window.showInformationMessage(
    '📋 Step 1: Get your Toggl API token from https://track.toggl.com/profile (scroll to bottom)',
    'Open Toggl Profile',
    'I have it'
  );

  if (tokenInfo === 'Open Toggl Profile') {
    vscode.env.openExternal(vscode.Uri.parse('https://track.toggl.com/profile'));
  }

  const apiToken = await vscode.window.showInputBox({
    prompt: 'Enter your Toggl API token',
    placeHolder: 'xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
    password: true,
    ignoreFocusOut: true,
  });

  if (!apiToken) {
    vscode.window.showWarningMessage('Setup cancelled. Run "Toggl: Setup" to try again.');
    return false;
  }

  // Validate token
  try {
    const response = await axios.get('https://api.track.toggl.com/api/v9/me', {
      auth: { username: apiToken, password: 'api_token' },
    });
    
    const user = response.data;
    vscode.window.showInformationMessage(`✅ Connected as ${user.fullname || user.email}`);
    
    // Save token
    await config.update('apiToken', apiToken, vscode.ConfigurationTarget.Global);
    
    // Get workspace ID from user's default
    const workspaceId = user.default_workspace_id;
    await config.update('workspaceId', workspaceId, vscode.ConfigurationTarget.Global);
    
  } catch (error) {
    vscode.window.showErrorMessage('❌ Invalid API token. Please check and try again.');
    return false;
  }

  // Monday.com integration - users should set MONDAY_TOKEN env var or configure in settings
  const mondayToken = getMondayToken();
  if (mondayToken) {
    await config.update('mondayApiToken', mondayToken, vscode.ConfigurationTarget.Global);
    vscode.window.showInformationMessage('✅ Monday.com integration configured from environment!');
  } else {
    vscode.window.showWarningMessage('⚠️ Set MONDAY_TOKEN env var for Monday.com integration');
  }

  vscode.window.showInformationMessage(
    '🎉 Setup complete! Toggl will now auto-track based on your git branch.'
  );

  return true;
}

interface TogglTimeEntry {
  id: number;
  description: string;
  start: string;
  workspace_id: number;
  project_id?: number;
}

interface MondayItem {
  id: string;
  name: string;
}

class TogglTracker {
  private statusBarItem: vscode.StatusBarItem;
  private currentBranch: string = '';
  private currentEntryId: number | null = null;
  private lastActivity: number = Date.now();
  private checkInterval: NodeJS.Timeout | null = null;
  private idleCheckInterval: NodeJS.Timeout | null = null;
  private isTracking: boolean = false;
  private taskCache: Map<string, string> = new Map();
  // Track last stopped entry for resume feature
  private lastStoppedDescription: string = '';
  private lastStoppedTime: number = 0;
  private lastStoppedEntryId: number | null = null;
  private currentDescription: string = '';

  constructor() {
    this.statusBarItem = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Left,
      100
    );
    this.statusBarItem.command = 'toggl-track-auto.status';
    this.statusBarItem.show();
    this.updateStatusBar('$(clock) Toggl: Initializing...');
  }

  private getConfig() {
    return vscode.workspace.getConfiguration('togglTrackAuto');
  }

  private updateStatusBar(text: string) {
    this.statusBarItem.text = text;
  }

  async start() {
    const config = this.getConfig();
    if (!config.get<boolean>('enabled')) {
      this.updateStatusBar('$(clock) Toggl: Disabled');
      return;
    }

    const apiToken = config.get<string>('apiToken');
    if (!apiToken) {
      this.updateStatusBar('$(warning) Toggl: No API token');
      vscode.window.showWarningMessage(
        'Toggl Track Auto: Please set your API token in settings'
      );
      return;
    }

    this.isTracking = true;
    await this.checkBranch();

    // Check branch every 10 seconds
    this.checkInterval = setInterval(() => this.checkBranch(), 10000);

    // Check for idle every 30 seconds
    this.idleCheckInterval = setInterval(() => this.checkIdle(), 30000);

    // Track activity
    vscode.workspace.onDidChangeTextDocument(() => this.onActivity());
    vscode.window.onDidChangeActiveTextEditor(() => this.onActivity());
    vscode.window.onDidChangeTextEditorSelection(() => this.onActivity());

    // Handle window focus - focused window takes over Toggl
    vscode.window.onDidChangeWindowState(async (state) => {
      if (state.focused && this.isTracking) {
        console.log('Window focused - taking over Toggl tracking');
        // Check what Toggl is currently tracking
        const currentTogglEntry = await this.getCurrentTogglEntry();
        const branch = await this.getCurrentBranch();
        
        if (branch) {
          // Get what this branch SHOULD be tracking
          const ticketId = this.extractTicketId(branch);
          let expectedDesc = branch;
          if (ticketId) {
            const taskName = await this.getMondayTaskName(ticketId);
            if (taskName) expectedDesc = taskName;
          }
          
          // If Toggl is tracking something different, switch to this branch
          if (!currentTogglEntry || currentTogglEntry.description !== expectedDesc) {
            console.log(`Switching from "${currentTogglEntry?.description}" to "${expectedDesc}"`);
            this.currentBranch = ''; // Force restart
            await this.checkBranch();
          }
        }
      }
    });
  }

  async stop() {
    this.isTracking = false;
    if (this.checkInterval) {
      clearInterval(this.checkInterval);
      this.checkInterval = null;
    }
    if (this.idleCheckInterval) {
      clearInterval(this.idleCheckInterval);
      this.idleCheckInterval = null;
    }
    await this.stopCurrentEntry();
    this.updateStatusBar('$(clock) Toggl: Stopped');
  }

  private onActivity() {
    this.lastActivity = Date.now();
  }

  private async checkIdle() {
    const config = this.getConfig();
    const idleTimeout = config.get<number>('idleTimeoutMinutes') || 5;
    const idleMs = idleTimeout * 60 * 1000;

    if (Date.now() - this.lastActivity > idleMs && this.currentEntryId) {
      await this.stopCurrentEntry();
      this.updateStatusBar('$(clock) Toggl: Idle (paused)');
    }
  }

  private async getCurrentBranch(): Promise<string | null> {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders || workspaceFolders.length === 0) {
      return null;
    }

    try {
      const { stdout } = await execAsync('git rev-parse --abbrev-ref HEAD', {
        cwd: workspaceFolders[0].uri.fsPath,
      });
      return stdout.trim();
    } catch {
      return null;
    }
  }

  private extractTicketId(branch: string): string | null {
    const config = this.getConfig();
    const pattern = config.get<string>('branchPattern') || '(\\d{6,})';
    const regex = new RegExp(pattern);
    const match = branch.match(regex);
    return match ? match[1] : null;
  }

  private async getMondayTaskName(ticketId: string): Promise<string | null> {
    // Check cache first
    if (this.taskCache.has(ticketId)) {
      return this.taskCache.get(ticketId)!;
    }

    const config = this.getConfig();
    const mondayToken = config.get<string>('mondayApiToken') || getMondayToken();

    try {
      const query = `
        query {
          items(ids: [${ticketId}]) {
            id
            name
          }
        }
      `;

      const response = await axios.post(
        'https://api.monday.com/v2',
        { query },
        {
          headers: {
            Authorization: mondayToken,
            'Content-Type': 'application/json',
          },
        }
      );

      const items = response.data?.data?.items;
      if (items && items.length > 0) {
        const name = items[0].name;
        this.taskCache.set(ticketId, name);
        return name;
      }
    } catch (error) {
      console.error('Failed to fetch Monday.com task:', error);
    }

    return null;
  }

  // Find previous Toggl entry with same description
  private async getPreviousEntry(description: string): Promise<any | null> {
    const config = this.getConfig();
    const apiToken = config.get<string>('apiToken');
    
    if (!apiToken) return null;
    
    try {
      // Get recent time entries (last 7 days)
      const endDate = new Date();
      const startDate = new Date();
      startDate.setDate(startDate.getDate() - 7);
      
      const response = await axios.get(
        `https://api.track.toggl.com/api/v9/me/time_entries`,
        {
          params: {
            start_date: startDate.toISOString(),
            end_date: endDate.toISOString(),
          },
          auth: { username: apiToken, password: 'api_token' },
        }
      );
      
      // Find most recent entry with matching description (stopped, not running)
      const entries = response.data || [];
      const matchingEntry = entries.find((e: any) => 
        e.description === description && e.duration >= 0
      );
      
      return matchingEntry || null;
    } catch (error) {
      console.error('Failed to fetch previous Toggl entries:', error);
    }
    
    return null;
  }

  private async getCurrentTogglEntry(): Promise<any | null> {
    const config = this.getConfig();
    const apiToken = config.get<string>('apiToken');
    
    if (!apiToken) return null;
    
    try {
      const response = await axios.get(
        'https://api.track.toggl.com/api/v9/me/time_entries/current',
        {
          auth: { username: apiToken, password: 'api_token' },
        }
      );
      return response.data;
    } catch (error) {
      return null;
    }
  }

  private async checkBranch() {
    if (!this.isTracking) return;

    const branch = await this.getCurrentBranch();
    if (!branch) {
      if (this.currentEntryId) {
        await this.stopCurrentEntry();
      }
      this.updateStatusBar('$(clock) Toggl: No git repo');
      return;
    }

    // Sync local state with Toggl (but don't prevent switching)
    const currentTogglEntry = await this.getCurrentTogglEntry();
    if (currentTogglEntry && currentTogglEntry.id) {
      // Track what Toggl is currently running
      this.currentEntryId = currentTogglEntry.id;
      this.currentDescription = currentTogglEntry.description || '';
    }

    // Resume tracking if we were idle
    if (!this.currentEntryId && Date.now() - this.lastActivity < 30000) {
      // Branch hasn't changed but we need to restart tracking
      this.currentBranch = ''; // Force restart
    }

    if (branch !== this.currentBranch) {
      this.currentBranch = branch;
      await this.stopCurrentEntry();
      await this.startNewEntry(branch);
    }
  }

  private async stopCurrentEntry() {
    if (!this.currentEntryId) return;

    const config = this.getConfig();
    const apiToken = config.get<string>('apiToken');
    const workspaceId = config.get<number>('workspaceId');

    if (!apiToken || !workspaceId) return;

    try {
      await axios.patch(
        `https://api.track.toggl.com/api/v9/workspaces/${workspaceId}/time_entries/${this.currentEntryId}/stop`,
        {},
        {
          auth: { username: apiToken, password: 'api_token' },
        }
      );
    } catch (error) {
      console.error('Failed to stop Toggl entry:', error);
    }

    // Save info for resume feature
    this.lastStoppedEntryId = this.currentEntryId;
    this.lastStoppedDescription = this.currentDescription;
    this.lastStoppedTime = Date.now();
    
    this.currentEntryId = null;
    this.currentDescription = '';
  }

  private async startNewEntry(branch: string) {
    const config = this.getConfig();
    const apiToken = config.get<string>('apiToken');
    const workspaceId = config.get<number>('workspaceId');
    let projectId = config.get<number>('projectId');

    if (!apiToken || !workspaceId) return;

    const ticketId = this.extractTicketId(branch);
    let description = branch;
    let tags: string[] = [];

    if (ticketId) {
      const taskName = await this.getMondayTaskName(ticketId);
      
      if (taskName) {
        // If we found a task name, just use it (no ID needed)
        description = taskName;
      } else {
        // No task name found, use ID + branch
        description = `[${ticketId}] ${branch}`;
      }
    }
    
    // Look up previous Toggl entry with same description
    const previousEntry = await this.getPreviousEntry(description);
    
    if (previousEntry) {
      // Reuse project and tags from previous entry
      if (previousEntry.project_id) {
        projectId = previousEntry.project_id;
      }
      if (previousEntry.tags && previousEntry.tags.length > 0) {
        tags = previousEntry.tags;
      }
      
      // Check if we should continue the previous entry (stopped within 10 min)
      const tenMinutesMs = 10 * 60 * 1000;
      const entryStopTime = new Date(previousEntry.stop).getTime();
      const timeSinceStop = Date.now() - entryStopTime;
      
      if (timeSinceStop < tenMinutesMs) {
        // Continue the previous entry by updating it to be running again
        console.log('Continuing previous Toggl entry');
        
        try {
          // Update the previous entry: set duration to -1 (running) and keep original start
          const response = await axios.put(
            `https://api.track.toggl.com/api/v9/workspaces/${workspaceId}/time_entries/${previousEntry.id}`,
            {
              duration: -1, // Make it running again
              stop: null,   // Remove stop time
            },
            {
              auth: { username: apiToken, password: 'api_token' },
            }
          );
          
          this.currentEntryId = response.data.id;
          this.currentDescription = description;
          this.updateStatusBar(`$(clock) Toggl: ${description.substring(0, 30)}... (continued)`);
          return;
        } catch (error) {
          console.error('Failed to continue entry, creating new one:', error);
        }
      }
    }

    try {

      const payload: any = {
        description,
        workspace_id: workspaceId,
        start: new Date().toISOString(),
        duration: -1, // Running timer
        created_with: 'toggl-track-vscode',
        billable: true,
      };

      if (projectId && projectId > 0) {
        payload.project_id = projectId;
      }

      if (tags.length > 0) {
        payload.tags = tags;
      }

      const response = await axios.post(
        `https://api.track.toggl.com/api/v9/workspaces/${workspaceId}/time_entries`,
        payload,
        {
          auth: { username: apiToken, password: 'api_token' },
        }
      );

      this.currentEntryId = response.data.id;
      this.currentDescription = description;
      this.updateStatusBar(`$(clock) Toggl: ${description.substring(0, 30)}...`);
      
    } catch (error) {
      console.error('Failed to start Toggl entry:', error);
      this.updateStatusBar('$(warning) Toggl: Error starting timer');
    }
  }

  async showStatus() {
    const config = this.getConfig();
    const apiToken = config.get<string>('apiToken');
    const workspaceId = config.get<number>('workspaceId');

    if (!apiToken) {
      vscode.window.showInformationMessage('Toggl: No API token configured');
      return;
    }

    try {
      const response = await axios.get(
        'https://api.track.toggl.com/api/v9/me/time_entries/current',
        {
          auth: { username: apiToken, password: 'api_token' },
        }
      );

      const entry = response.data;
      if (entry) {
        const start = new Date(entry.start);
        const duration = Math.floor((Date.now() - start.getTime()) / 1000 / 60);
        vscode.window.showInformationMessage(
          `Toggl: Currently tracking "${entry.description}" (${duration} min)`
        );
      } else {
        vscode.window.showInformationMessage('Toggl: No active time entry');
      }
    } catch (error) {
      vscode.window.showErrorMessage('Toggl: Failed to fetch status');
    }
  }

  dispose() {
    // Stop tracking and timer synchronously as much as possible
    this.isTracking = false;
    if (this.checkInterval) {
      clearInterval(this.checkInterval);
      this.checkInterval = null;
    }
    if (this.idleCheckInterval) {
      clearInterval(this.idleCheckInterval);
      this.idleCheckInterval = null;
    }
    // Fire the stop request (don't await - extension may close before it completes)
    this.stopCurrentEntry().catch(() => {});
    this.statusBarItem.dispose();
  }
}

let tracker: TogglTracker;

const GITHUB_REPO = 'alexdeg92/toggl-track-vscode';

async function checkForUpdates(context: vscode.ExtensionContext) {
  try {
    const extension = vscode.extensions.getExtension('toggl-track-auto.toggl-track-auto');
    const currentVersion = extension?.packageJSON?.version || '0.0.0';
    
    const response = await axios.get(
      `https://api.github.com/repos/${GITHUB_REPO}/releases/latest`,
      { headers: { 'Accept': 'application/vnd.github.v3+json' } }
    );
    
    const latestVersion = response.data.tag_name?.replace('v', '') || '0.0.0';
    const vsixAsset = response.data.assets?.find((a: any) => a.name.endsWith('.vsix'));
    
    if (latestVersion > currentVersion && vsixAsset) {
      const action = await vscode.window.showInformationMessage(
        `Toggl Track Auto v${latestVersion} is available (you have v${currentVersion})`,
        'Download & Install',
        'Later'
      );
      
      if (action === 'Download & Install') {
        // Download the VSIX
        const downloadPath = path.join(context.globalStorageUri.fsPath, vsixAsset.name);
        await vscode.workspace.fs.createDirectory(context.globalStorageUri);
        
        const vsixResponse = await axios.get(vsixAsset.browser_download_url, {
          responseType: 'arraybuffer'
        });
        
        await vscode.workspace.fs.writeFile(
          vscode.Uri.file(downloadPath),
          new Uint8Array(vsixResponse.data)
        );
        
        // Install the extension
        await vscode.commands.executeCommand(
          'workbench.extensions.installExtension',
          vscode.Uri.file(downloadPath)
        );
        
        const reload = await vscode.window.showInformationMessage(
          `Toggl Track Auto v${latestVersion} installed! Reload to activate.`,
          'Reload Now'
        );
        
        if (reload === 'Reload Now') {
          await vscode.commands.executeCommand('workbench.action.reloadWindow');
        }
      }
    }
  } catch (error) {
    console.error('Failed to check for updates:', error);
  }
}

export async function activate(context: vscode.ExtensionContext) {
  tracker = new TogglTracker();
  
  // Check for updates on startup (after 5 seconds to not slow down activation)
  setTimeout(() => checkForUpdates(context), 5000);

  context.subscriptions.push(
    vscode.commands.registerCommand('toggl-track-auto.start', () => tracker.start()),
    vscode.commands.registerCommand('toggl-track-auto.stop', () => tracker.stop()),
    vscode.commands.registerCommand('toggl-track-auto.status', () => tracker.showStatus()),
    vscode.commands.registerCommand('toggl-track-auto.setup', async () => {
      const success = await runSetupWizard();
      if (success) {
        tracker.start();
      }
    })
  );

  // Add tracker to subscriptions for proper disposal
  context.subscriptions.push(tracker);

  // Check if setup is needed
  const config = vscode.workspace.getConfiguration('togglTrackAuto');
  if (!config.get<string>('apiToken')) {
    const success = await runSetupWizard();
    if (success) {
      tracker.start();
    }
  } else {
    // Auto-start if already configured
    tracker.start();
  }
}

export function deactivate() {
  if (tracker) {
    tracker.dispose();
  }
}
