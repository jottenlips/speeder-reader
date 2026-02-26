import React from 'react';
import { NavigationContainer } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { StatusBar } from 'expo-status-bar';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { StyleSheet } from 'react-native';

import HomeScreen from './src/screens/HomeScreen';
import ReaderScreen from './src/screens/ReaderScreen';
import { WordEntry } from './src/utils/pdfParser';
import { LanguageProvider } from './src/contexts/LanguageContext';
import { ThemeProvider, useTheme } from './src/contexts/ThemeContext';

export type RootStackParamList = {
  Home: undefined;
  Reader: {
    words: WordEntry[];
    wpm: number;
    numPages: number;
    startIndex: number;
    fileKey: string;
    /** When true, the item is auto-archived in the library when reading finishes. */
    isLibraryItem?: boolean;
  };
};

const Stack = createNativeStackNavigator<RootStackParamList>();

function AppContent() {
  const { scheme } = useTheme();
  const isDark = scheme === 'dark';
  return (
    <>
      <StatusBar style={isDark ? 'light' : 'dark'} />
      <NavigationContainer>
        <Stack.Navigator
          screenOptions={{
            headerShown: false,
            contentStyle: { backgroundColor: isDark ? '#18100A' : '#F4F1EA' },
            animation: 'slide_from_right',
          }}
        >
          <Stack.Screen name="Home" component={HomeScreen} />
          <Stack.Screen name="Reader" component={ReaderScreen} />
        </Stack.Navigator>
      </NavigationContainer>
    </>
  );
}

export default function App() {
  return (
    <LanguageProvider>
      <ThemeProvider>
        <GestureHandlerRootView style={styles.root}>
          <AppContent />
        </GestureHandlerRootView>
      </ThemeProvider>
    </LanguageProvider>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
  },
});
