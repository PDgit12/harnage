export interface ConvMessage {
	role: string;
	content: string;
	timestamp: number;
}
export const conversation: ConvMessage[] = [];
