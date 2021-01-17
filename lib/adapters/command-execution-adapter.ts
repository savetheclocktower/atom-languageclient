import { ExecuteCommandParams, ServerCapabilities } from "../languageclient";
import { LanguageClientConnection } from "../main";

export type CommandCustomCallbackFunction = (command: ExecuteCommandParams) => Promise<any | void>;

export default class CommandExecutionAdapter {
    private static commandsCustomCallbacks: Map<string, CommandCustomCallbackFunction> = new Map<string, CommandCustomCallbackFunction>();

    public static canAdapt(serverCapabilities: ServerCapabilities): boolean {
      return serverCapabilities.executeCommandProvider != null;
    }

    public static registerCustomCallbackForCommand(command: string, callback: CommandCustomCallbackFunction): void {
        this.commandsCustomCallbacks.set(command, callback);
    }

    public static async executeCommand(connection: LanguageClientConnection, command: string, commandArgs?: any[] | undefined): Promise<any | void> {
        const executeCommandParams = CommandExecutionAdapter.createExecuteCommandParams(command, commandArgs);
        const commandCustomCallback = this.commandsCustomCallbacks.get(command);

        return commandCustomCallback != null ? await commandCustomCallback(executeCommandParams) : await connection.executeCommand(executeCommandParams);
    }

    private static createExecuteCommandParams(command: string, commandArgs?: any[] | undefined): ExecuteCommandParams {
        return {
            command: command,
            arguments: commandArgs
        };
    }
}
