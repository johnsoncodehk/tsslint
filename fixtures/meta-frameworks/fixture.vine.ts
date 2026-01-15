function MyComponent() {
	return vine`<div>{{ console.log('Hello, world!') }}</div>`;
}

// This is also valid
const AnotherComponent = () => vine`<div>Hello World</div>`;
